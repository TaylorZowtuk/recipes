# A stack's kill switch: a Lambda that sets the API's reserved concurrency to 0 when either SNS
# topic it is subscribed to gets a message (hosting ADR). The account's spend alarm topic (made by
# infra/bootstrap, in us-east-1, which also subscribes this function to it) trips every stack at
# once; the stack's own topic trips only this one, for testing. The phones then show "Editing is
# paused." while the PWA and images keep serving.
# Re-enabling is by hand: scripts/deploy.sh keeps a tripped switch tripped (infra/AGENTS.md,
# "Spend guard").
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name" {
  description = "The function's, role's and stack topic's name, for example plateful-staging-kill-switch."
  type        = string
}

variable "zip_path" {
  description = "The API's Lambda zip, which holds the recipes.kill_switch handler too."
  type        = string
}

variable "runtime" {
  type = string
}

variable "api_function_name" {
  type = string
}

variable "api_function_arn" {
  type = string
}

variable "account_topic_arn" {
  description = "The account-wide spend alarm topic in us-east-1 (infra/bootstrap's spend_alarm_topic_arn)."
  type        = string
}

variable "permissions_boundary_arn" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 14
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
  name                 = var.name
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = var.log_retention_days
}

# Only the API's concurrency, and its own logs.
data "aws_iam_policy_document" "this" {
  statement {
    actions   = ["lambda:PutFunctionConcurrency", "lambda:GetFunctionConcurrency"]
    resources = [var.api_function_arn]
  }

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
}

resource "aws_iam_role_policy" "this" {
  name   = "kill-switch"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.this.json
}

resource "aws_lambda_function" "this" {
  function_name    = var.name
  role             = aws_iam_role.this.arn
  runtime          = var.runtime
  architectures    = ["arm64"]
  handler          = "recipes.kill_switch.handler"
  filename         = var.zip_path
  source_code_hash = filebase64sha256(var.zip_path)
  memory_size      = 128
  timeout          = 10

  environment {
    variables = {
      API_FUNCTION_NAME = var.api_function_name
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.this.name
  }

  depends_on = [aws_iam_role_policy.this]
}

resource "aws_sns_topic" "stack" {
  name = var.name
}

locals {
  topic_arns = {
    stack   = aws_sns_topic.stack.arn
    account = var.account_topic_arn
  }
}

# infra/bootstrap's subscription to the account topic delivers only because of its permission here.
resource "aws_lambda_permission" "sns" {
  for_each      = local.topic_arns
  statement_id  = "SnsInvoke-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = each.value
}

resource "aws_sns_topic_subscription" "stack" {
  topic_arn  = aws_sns_topic.stack.arn
  protocol   = "lambda"
  endpoint   = aws_lambda_function.this.arn
  depends_on = [aws_lambda_permission.sns]
}

output "function_name" {
  value = aws_lambda_function.this.function_name
}

output "wiring" {
  description = "The function's name, the API function it throttles and the topics that may invoke it, for infra/tests."
  value = {
    function_name     = aws_lambda_function.this.function_name
    api_function_name = aws_lambda_function.this.environment[0].variables["API_FUNCTION_NAME"]
    topic_arns        = { for k, p in aws_lambda_permission.sns : k => p.source_arn }
  }
}

output "topic_arn" {
  description = "The stack's own topic: publishing to it trips only this stack."
  value       = aws_sns_topic.stack.arn
}
