# A private S3 bucket: all public access blocked, owner-enforced objects, SSE-S3 encryption and
# optional versioning. Who may read it is set by the caller's bucket policy.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name" {
  description = "Globally unique bucket name."
  type        = string
}

variable "versioned" {
  description = "Keep object versions. Off unless an ADR asks for it, since old versions are billed storage."
  type        = bool
  default     = false
}

variable "force_destroy" {
  description = "Let `terraform destroy` empty the bucket first."
  type        = bool
  default     = false
}

resource "aws_s3_bucket" "this" {
  bucket        = var.name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "this" {
  count  = var.versioned ? 1 : 0
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

output "name" {
  value = aws_s3_bucket.this.id
}

output "arn" {
  value = aws_s3_bucket.this.arn
}

output "regional_domain_name" {
  value = aws_s3_bucket.this.bucket_regional_domain_name
}
