# The one place a stack's resource names are decided, and the IAM policy that reaches its data.
# It makes no API calls, so both a stack and infra/bootstrap (whose deploy roles and permissions
# boundaries must name a stack's resources before they exist) can call it.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "stack" {
  description = "Stack name, for example prod or staging."
  type        = string
}

variable "account_id" {
  description = "AWS account ID."
  type        = string
}

variable "region" {
  description = "The stack's AWS region."
  type        = string
}

locals {
  # Every resource a stack makes is named with this prefix, which the deploy role's policy relies on.
  prefix        = "plateful-${var.stack}"
  table_name    = local.prefix
  pwa_bucket    = "${local.prefix}-pwa-${var.account_id}"
  images_bucket = "${local.prefix}-images-${var.account_id}"
  ssm_prefix    = "/plateful/${var.stack}/"
  function_name = "${local.prefix}-api"
  # The kill switch's function, role, log group and SNS topic.
  kill_switch_name = "${local.prefix}-kill-switch"

  table_arn         = "arn:aws:dynamodb:${var.region}:${var.account_id}:table/${local.table_name}"
  images_bucket_arn = "arn:aws:s3:::${local.images_bucket}"
  ssm_path_arn      = "arn:aws:ssm:${var.region}:${var.account_id}:parameter/plateful/${var.stack}"
  boundary_name     = "${local.prefix}-boundary"
  oac_names = {
    api    = "${local.prefix}-api"
    pwa    = "${local.prefix}-pwa"
    images = "${local.prefix}-images"
  }
  # infra/bootstrap's state bucket and backend key, which hold the stack's OAC IDs.
  state_bucket        = "plateful-tfstate-${var.account_id}"
  bootstrap_state_key = "bootstrap/terraform.tfstate"
  # Outside the prefix on purpose: the deploy role may change only resources with the prefix.
  deploy_role_name = "plateful-deploy-${var.stack}"
}

# What the API, and staging's dev user, may do: read and write the table and the images bucket,
# and read the stack's SSM parameters.
data "aws_iam_policy_document" "data" {
  statement {
    sid = "Table"
    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:UpdateItem",
    ]
    resources = [local.table_arn]
  }

  statement {
    sid       = "ImagesList"
    actions   = ["s3:ListBucket"]
    resources = [local.images_bucket_arn]
  }

  statement {
    sid       = "ImagesObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.images_bucket_arn}/*"]
  }

  statement {
    sid       = "Secrets"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = [local.ssm_path_arn, "${local.ssm_path_arn}/*"]
  }

  # SecureStrings use the AWS-managed aws/ssm key, which can only be used through SSM.
  statement {
    sid       = "SecretsDecrypt"
    actions   = ["kms:Decrypt"]
    resources = ["arn:aws:kms:${var.region}:${var.account_id}:key/*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

output "prefix" {
  value = local.prefix
}

output "table_name" {
  value = local.table_name
}

output "pwa_bucket" {
  value = local.pwa_bucket
}

output "images_bucket" {
  value = local.images_bucket
}

output "ssm_prefix" {
  value = local.ssm_prefix
}

output "function_name" {
  value = local.function_name
}

output "kill_switch_name" {
  value = local.kill_switch_name
}

output "boundary_name" {
  value = local.boundary_name
}

output "boundary_arn" {
  description = "The permissions boundary (made by infra/bootstrap) that every IAM role and user the stack makes must carry."
  value       = "arn:aws:iam::${var.account_id}:policy/${local.boundary_name}"
}

output "oac_names" {
  description = "The stack's CloudFront OAC names by origin (made by infra/bootstrap)."
  value       = local.oac_names
}

output "state_bucket" {
  value = local.state_bucket
}

output "bootstrap_state_key" {
  value = local.bootstrap_state_key
}

output "deploy_role_name" {
  value = local.deploy_role_name
}

output "deploy_role_arn" {
  description = "The GitHub Actions deploy role (made by infra/bootstrap)."
  value       = "arn:aws:iam::${var.account_id}:role/${local.deploy_role_name}"
}

output "data_policy_json" {
  value = data.aws_iam_policy_document.data.json
}
