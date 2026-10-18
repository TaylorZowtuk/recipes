# The prod stack. Shared resources are in ../../modules/stack; this file holds only prod's values.
# Init with the state bucket from infra/bootstrap:
#   terraform init -backend-config="bucket=plateful-tfstate-<account id>"
terraform {
  required_version = "~> 1.16" # the toolchain image pins the exact version (docker/Dockerfile)

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
  }

  backend "s3" {
    key          = "prod/terraform.tfstate"
    region       = "ca-west-1"
    encrypt      = true
    use_lockfile = true
  }
}

locals {
  stack = "prod"
  tags = {
    Project = "plateful"
    Stack   = local.stack # the deploy role scopes CloudFront by this tag
  }
}

provider "aws" {
  region = "ca-west-1"
  default_tags {
    tags = local.tags
  }
}

# CloudFront-scoped WAF web ACLs live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = local.tags
  }
}

variable "lambda_zip" {
  description = "The API's Lambda zip, built by `make lambda`."
  type        = string
  default     = "../../../backend/dist/lambda.zip"
}

variable "lambda_runtime" {
  description = "Lambda runtime. Matches backend/.python-version; the backend Lambda packaging checks it exists in ca-west-1."
  type        = string
  default     = "python3.14"
}

variable "lwa_layer_arn" {
  description = "AWS Lambda Web Adapter layer for arm64 in ca-west-1."
  type        = string
  default     = "arn:aws:lambda:ca-west-1:753240598075:layer:LambdaAdapterLayerArm64:30"
}

module "stack" {
  source = "../../modules/stack"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
  stack               = local.stack
  read_capacity       = 10
  write_capacity      = 10
  deletion_protection = true
  lambda_zip          = var.lambda_zip
  lambda_runtime      = var.lambda_runtime
  lwa_layer_arn       = var.lwa_layer_arn
}
