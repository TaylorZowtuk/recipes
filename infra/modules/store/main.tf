# A stack's data: its DynamoDB table, its images bucket and its sign-in secrets in SSM.
# See docs/adr/2026-09-27-dynamodb-source-of-truth-and-backups.md and 2026-09-29-editor-sign-in.md.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "table_name" {
  type = string
}

variable "images_bucket" {
  type = string
}

variable "ssm_prefix" {
  description = "Path the stack's parameters live under, with a trailing slash."
  type        = string
}

variable "read_capacity" {
  description = "Provisioned RCU. Prod and staging together stay at or below 25 (stacks ADR)."
  type        = number
}

variable "write_capacity" {
  description = "Provisioned WCU. Prod and staging together stay at or below 25 (stacks ADR)."
  type        = number
}

variable "deletion_protection" {
  description = "Refuse to delete the table."
  type        = bool
}

locals {
  # Placeholder values only: the human sets the real ones (`aws ssm put-parameter --overwrite`).
  # The value is write-only, so Terraform writes the placeholder once, never stores the secret in
  # state and never reverts it.
  secrets = {
    "editor-allowlist"   = "The editors' email addresses, comma-separated."
    "session-hmac-key"   = "The key that signs editor session cookies."
    "service-token-hash" = "The hex SHA-256 of this stack's service token."
    # Not secret (browsers get it from /api/session), but a SecureString too, so the API reads all
    # four with one GetParameters call.
    "google-client-id" = "The stack's Google OAuth web client ID."
  }
}

# One table, no secondary indexes. The data model ADR names items by partition (CARD, WEEK#<monday>,
# SOURCE#<dedupe_key>, META#schema, ...) but not the key attributes, so they are PK and SK strings.
# Provisioned with no auto scaling, so excess traffic throttles instead of billing. No
# point-in-time recovery: the backup ADR rejected it in favour of nightly snapshots.
resource "aws_dynamodb_table" "this" {
  name                        = var.table_name
  billing_mode                = "PROVISIONED"
  read_capacity               = var.read_capacity
  write_capacity              = var.write_capacity
  hash_key                    = "PK"
  range_key                   = "SK"
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  server_side_encryption {
    enabled = false # AWS-owned key: free, unlike the AWS-managed KMS key
  }
}

# Images are stored once under content-hashed keys (images/<hash>.webp) and never change, so the
# bucket isn't versioned; the backup bucket holds the copies.
module "images" {
  source = "../private-bucket"
  name   = var.images_bucket
}

resource "aws_ssm_parameter" "secret" {
  for_each         = local.secrets
  name             = "${var.ssm_prefix}${each.key}"
  description      = each.value
  type             = "SecureString"
  tier             = "Standard"
  value_wo         = "placeholder-set-by-hand"
  value_wo_version = 1
}

output "table_name" {
  value = aws_dynamodb_table.this.name
}

output "table_arn" {
  value = aws_dynamodb_table.this.arn
}

output "table_capacity" {
  description = "The table's provisioned read and write capacity units."
  value = {
    read  = aws_dynamodb_table.this.read_capacity
    write = aws_dynamodb_table.this.write_capacity
  }
}

output "images_bucket" {
  value = module.images.name
}

output "images_bucket_arn" {
  value = module.images.arn
}

output "images_bucket_regional_domain_name" {
  value = module.images.regional_domain_name
}

output "ssm_prefix" {
  value = var.ssm_prefix
}
