# One whole stack: its data (store), the API and the CloudFront site. stacks/prod and
# stacks/staging call this with their own values; infra/bootstrap must already have made the
# stack's deploy role, permissions boundary and CloudFront OACs.
terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

variable "stack" {
  type = string
}

variable "read_capacity" {
  type = number
}

variable "write_capacity" {
  type = number
}

variable "deletion_protection" {
  type = bool
}

variable "lambda_zip" {
  type = string
}

locals {
  # The runtime follows the Python the Lambda zip's wheels are built for (scripts/lambda.sh).
  lambda_runtime = "python${trimspace(file("${path.module}/../../../backend/.python-version"))}"
  # The AWS Lambda Web Adapter layer for arm64, published under the same version in every region.
  lwa_layer_arn = "arn:aws:lambda:${data.aws_region.current.region}:753240598075:layer:LambdaAdapterLayerArm64:30"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

module "access" {
  source     = "../stack-access"
  stack      = var.stack
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
}

# The stack's OACs belong to infra/bootstrap; their IDs come from its state.
data "terraform_remote_state" "bootstrap" {
  backend = "s3"
  config = {
    bucket = module.access.state_bucket
    key    = module.access.bootstrap_state_key
    region = data.aws_region.current.region
  }
}

module "store" {
  source              = "../store"
  table_name          = module.access.table_name
  images_bucket       = module.access.images_bucket
  ssm_prefix          = module.access.ssm_prefix
  read_capacity       = var.read_capacity
  write_capacity      = var.write_capacity
  deletion_protection = var.deletion_protection
}

module "api" {
  source                   = "../api"
  function_name            = module.access.function_name
  zip_path                 = var.lambda_zip
  runtime                  = local.lambda_runtime
  lwa_layer_arn            = local.lwa_layer_arn
  data_policy_json         = module.access.data_policy_json
  permissions_boundary_arn = module.access.boundary_arn
  environment = {
    TABLE_NAME    = module.store.table_name
    IMAGES_BUCKET = module.store.images_bucket
    SSM_PREFIX    = module.store.ssm_prefix
  }
}

module "site" {
  source = "../site"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
  prefix                             = module.access.prefix
  pwa_bucket                         = module.access.pwa_bucket
  images_bucket                      = module.store.images_bucket
  images_bucket_arn                  = module.store.images_bucket_arn
  images_bucket_regional_domain_name = module.store.images_bucket_regional_domain_name
  function_name                      = module.api.function_name
  function_url_domain                = module.api.function_url_domain
  origin_access_control_ids          = data.terraform_remote_state.bootstrap.outputs.origin_access_control_ids[var.stack]
}

output "access" {
  description = "Names and policies shared with the dev user."
  value = {
    prefix           = module.access.prefix
    boundary_arn     = module.access.boundary_arn
    data_policy_json = module.access.data_policy_json
  }
}

output "distribution_domain" {
  value = module.site.distribution_domain
}

output "distribution_id" {
  value = module.site.distribution_id
}

output "distribution_arn" {
  value = module.site.distribution_arn
}

output "web_acl_arn" {
  value = module.site.web_acl_arn
}

output "pwa_bucket" {
  value = module.site.pwa_bucket
}

output "images_bucket" {
  value = module.store.images_bucket
}

output "function_name" {
  value = module.api.function_name
}

output "table_name" {
  value = module.store.table_name
}

output "table_capacity" {
  value = module.store.table_capacity
}

output "deploy_role_arn" {
  value = module.access.deploy_role_arn
}
