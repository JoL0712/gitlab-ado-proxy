###############################################################################
# GitLab-ADO Proxy - AWS Lambda Deployment
# 
# This Terraform configuration deploys the proxy as an AWS Lambda function
# with a Function URL for HTTP access.
###############################################################################

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "gitlab-ado-proxy"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

###############################################################################
# Local Variables
###############################################################################

locals {
  function_name = "${var.project_name}-${var.environment}"
  source_dir    = "${path.module}/../../"
  dist_dir      = "${local.source_dir}/dist/lambda"
}

###############################################################################
# Build Step - Bundle TypeScript with esbuild
###############################################################################

resource "null_resource" "build" {
  triggers = {
    # Rebuild when source files change.
    source_hash = sha256(join("", [
      filesha256("${local.source_dir}/src/core/app.ts"),
      filesha256("${local.source_dir}/src/core/mapping.ts"),
      filesha256("${local.source_dir}/src/core/types.ts"),
      filesha256("${local.source_dir}/src/adapters/aws-lambda.ts"),
      filesha256("${local.source_dir}/package.json"),
    ]))
  }

  provisioner "local-exec" {
    working_dir = local.source_dir
    command     = "npm ci && npm run build:lambda"
  }
}

###############################################################################
# Lambda Deployment Package
###############################################################################

data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = local.dist_dir
  output_path = "${path.module}/lambda.zip"

  depends_on = [null_resource.build]
}

###############################################################################
# IAM Role for Lambda
###############################################################################

resource "aws_iam_role" "lambda_role" {
  name = "${local.function_name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Optional: Add CloudWatch Logs policy for enhanced logging.
resource "aws_iam_role_policy" "lambda_logging" {
  name = "${local.function_name}-logging"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      }
    ]
  })
}

###############################################################################
# CloudWatch Log Group
###############################################################################

resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
}

###############################################################################
# Lambda Function
###############################################################################

resource "aws_lambda_function" "proxy" {
  function_name = local.function_name
  description   = "GitLab-ADO Proxy - Emulates GitLab API and proxies to Azure DevOps"

  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  handler = "index.handler"
  runtime = "nodejs20.x"

  role        = aws_iam_role.lambda_role.arn
  timeout     = var.lambda_timeout
  memory_size = var.lambda_memory

  environment {
    variables = merge(
      {
        ADO_BASE_URL    = var.ado_base_url
        ADO_API_VERSION = var.ado_api_version
        NODE_ENV        = var.environment
      },
      var.oauth_client_id != "" ? { OAUTH_CLIENT_ID = var.oauth_client_id } : {},
      var.oauth_client_secret != "" ? { OAUTH_CLIENT_SECRET = var.oauth_client_secret } : {}
    )
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda_logs,
    aws_iam_role_policy_attachment.lambda_basic_execution,
  ]
}

###############################################################################
# Lambda Function URL (Public HTTP Endpoint)
###############################################################################

resource "aws_lambda_function_url" "proxy_url" {
  function_name      = aws_lambda_function.proxy.function_name
  authorization_type = var.function_url_auth_type

  cors {
    allow_origins     = var.cors_allowed_origins
    allow_methods     = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
    allow_headers     = ["*"]
    expose_headers    = ["*"]
    allow_credentials = true
    max_age           = 86400
  }
}

###############################################################################
# Optional: CloudWatch Alarms for Monitoring
###############################################################################

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${local.function_name}-errors"
  alarm_description   = "Lambda function error rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.proxy.function_name
  }

  alarm_actions = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []
}

resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${local.function_name}-duration"
  alarm_description   = "Lambda function duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Average"
  threshold           = var.lambda_timeout * 1000 * 0.8  # 80% of timeout
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.proxy.function_name
  }

  alarm_actions = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []
}
