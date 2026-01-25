###############################################################################
# Outputs
###############################################################################

output "function_url" {
  description = "Lambda Function URL endpoint"
  value       = aws_lambda_function_url.proxy_url.function_url
}

output "function_name" {
  description = "Lambda function name"
  value       = aws_lambda_function.proxy.function_name
}

output "function_arn" {
  description = "Lambda function ARN"
  value       = aws_lambda_function.proxy.arn
}

output "log_group_name" {
  description = "CloudWatch Log Group name"
  value       = aws_cloudwatch_log_group.lambda_logs.name
}

output "iam_role_arn" {
  description = "IAM role ARN for the Lambda function"
  value       = aws_iam_role.lambda_role.arn
}

output "api_endpoints" {
  description = "Available API endpoints"
  value = {
    health             = "${aws_lambda_function_url.proxy_url.function_url}health"
    get_project        = "${aws_lambda_function_url.proxy_url.function_url}api/v4/projects/:id"
    list_branches      = "${aws_lambda_function_url.proxy_url.function_url}api/v4/projects/:id/repository/branches"
    create_mr          = "${aws_lambda_function_url.proxy_url.function_url}api/v4/projects/:id/merge_requests"
    list_mrs           = "${aws_lambda_function_url.proxy_url.function_url}api/v4/projects/:id/merge_requests"
  }
}
