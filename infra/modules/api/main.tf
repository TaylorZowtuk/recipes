# The API: FastAPI in a zip Lambda behind the AWS Lambda Web Adapter, reached only through an
# AWS_IAM function URL that CloudFront signs with OAC (hosting ADR). The CloudFront invoke
# permissions live in the site module, next to the distribution they name.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "function_name" {
  type = string
}

variable "zip_path" {
  description = "The Lambda zip that `make lambda` builds (backend/dist/lambda.zip). Terraform owns the code: a new zip hash is a planned change."
  type        = string
}

variable "runtime" {
  description = "Lambda Python runtime. The backend pins its Python in backend/.python-version; check the runtime exists in the stack's region."
  type        = string
}

variable "lwa_layer_arn" {
  description = "ARN of the AWS Lambda Web Adapter layer for arm64 in this region (LambdaAdapterLayerArm64)."
  type        = string
}

variable "memory_size" {
  type    = number
  default = 512
}

variable "timeout" {
  type    = number
  default = 30
}

variable "reserved_concurrency" {
  description = "Concurrent executions reserved for, and the most allowed to, the API. Bounds spend while a spend alarm lags; the kill switch sets it to 0."
  type        = number
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "environment" {
  description = "App settings: TABLE_NAME, IMAGES_BUCKET and SSM_PREFIX."
  type        = map(string)
}

variable "data_policy_json" {
  description = "The stack's data access policy (stack-access module)."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Boundary the execution role must carry, so the deploy role can't make a broader one."
  type        = string
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = var.function_name
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy" "data" {
  name   = "data"
  role   = aws_iam_role.this.id
  policy = var.data_policy_json
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "logs" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
}

resource "aws_iam_role_policy" "logs" {
  name   = "logs"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_lambda_function" "this" {
  function_name    = var.function_name
  role             = aws_iam_role.this.arn
  runtime          = var.runtime
  architectures    = ["arm64"]
  handler          = "run.sh"
  filename         = var.zip_path
  source_code_hash = filebase64sha256(var.zip_path)
  layers           = [var.lwa_layer_arn]
  memory_size      = var.memory_size
  timeout          = var.timeout

  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = merge(var.environment, {
      AWS_LAMBDA_EXEC_WRAPPER = "/opt/bootstrap"
      PORT                    = "8080"
      # The adapter's readiness check defaults to /, which FastAPI 404s.
      AWS_LWA_READINESS_CHECK_PATH = "/api/sync"
    })
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.this.name
  }

  depends_on = [aws_iam_role_policy.logs]
}

resource "aws_lambda_function_url" "this" {
  function_name      = aws_lambda_function.this.function_name
  authorization_type = "AWS_IAM"
}

output "function_name" {
  value = aws_lambda_function.this.function_name
}

output "function_arn" {
  value = aws_lambda_function.this.arn
}

output "function_url_domain" {
  description = "The function URL's host, for the CloudFront origin."
  value       = split("/", aws_lambda_function_url.this.function_url)[2]
}
