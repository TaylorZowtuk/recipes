# Staging's dev user (hosting decision D3): `make dev STAGING_PROFILE=...` needs static keys, so this
# user reaches only staging's table, images bucket and SSM path. Terraform makes no access key; the
# human makes one by hand and keeps it in ~/.aws. Never call this module from prod.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name" {
  type = string
}

variable "data_policy_json" {
  description = "The stack's data access policy (stack-access module)."
  type        = string
}

variable "permissions_boundary_arn" {
  type = string
}

resource "aws_iam_user" "this" {
  name                 = var.name
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_user_policy" "data" {
  name   = "data"
  user   = aws_iam_user.this.name
  policy = var.data_policy_json
}

output "name" {
  value = aws_iam_user.this.name
}
