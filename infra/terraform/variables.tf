###############################################################################
# Required Variables
###############################################################################

variable "ado_base_url" {
  description = "Azure DevOps organization URL (e.g., https://dev.azure.com/org). The proxy is project-agnostic and uses repository GUIDs."
  type        = string

  validation {
    condition     = can(regex("^https://", var.ado_base_url))
    error_message = "ADO base URL must start with https://"
  }
}

###############################################################################
# Optional Variables with Defaults
###############################################################################

variable "aws_region" {
  description = "AWS region to deploy to"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod"
  }
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "gitlab-ado-proxy"
}

variable "ado_api_version" {
  description = "Azure DevOps API version"
  type        = string
  default     = "7.1"
}

###############################################################################
# Lambda Configuration
###############################################################################

variable "lambda_timeout" {
  description = "Lambda function timeout in seconds"
  type        = number
  default     = 30

  validation {
    condition     = var.lambda_timeout >= 1 && var.lambda_timeout <= 900
    error_message = "Lambda timeout must be between 1 and 900 seconds"
  }
}

variable "lambda_memory" {
  description = "Lambda function memory in MB"
  type        = number
  default     = 256

  validation {
    condition     = var.lambda_memory >= 128 && var.lambda_memory <= 10240
    error_message = "Lambda memory must be between 128 and 10240 MB"
  }
}

###############################################################################
# Function URL Configuration
###############################################################################

variable "function_url_auth_type" {
  description = "Authorization type for Lambda Function URL (NONE or AWS_IAM)"
  type        = string
  default     = "NONE"

  validation {
    condition     = contains(["NONE", "AWS_IAM"], var.function_url_auth_type)
    error_message = "Authorization type must be NONE or AWS_IAM"
  }
}

variable "cors_allowed_origins" {
  description = "List of allowed CORS origins"
  type        = list(string)
  default     = ["*"]
}

###############################################################################
# Logging Configuration
###############################################################################

variable "log_retention_days" {
  description = "CloudWatch log retention period in days"
  type        = number
  default     = 14

  validation {
    condition = contains([
      1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653
    ], var.log_retention_days)
    error_message = "Log retention must be a valid CloudWatch retention period"
  }
}

###############################################################################
# Monitoring Configuration
###############################################################################

variable "enable_alarms" {
  description = "Enable CloudWatch alarms for monitoring"
  type        = bool
  default     = false
}

variable "alarm_sns_topic_arn" {
  description = "SNS topic ARN for alarm notifications"
  type        = string
  default     = ""
}
