# The Free plan and capacity rules (hosting and stacks ADRs), checked offline against mock
# providers: provisioned DynamoDB at the stacks' capacities, managed CloudFront policies only, at
# most five behaviours, no distribution-wide error responses, noindex.js on every behaviour,
# spa.js on the default one only, and the bootstrap-made OAC on every origin.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { region = "ca-west-1" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_cloudfront_function" {
    defaults = { arn = "arn:aws:cloudfront::123456789012:function/mock" }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = { arn = "arn:aws:cloudfront::123456789012:distribution/MOCK" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:ca-west-1:123456789012:log-group:mock" }
  }
  mock_resource "aws_lambda_function_url" {
    defaults = { function_url = "https://abc.lambda-url.ca-west-1.on.aws/" }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:us-east-1:123456789012:global/webacl/mock/1" }
  }
}

run "site" {
  command = apply # against the mock providers: nothing reaches AWS

  module {
    source = "../modules/site"
  }

  variables {
    prefix                             = "plateful-test"
    pwa_bucket                         = "plateful-test-pwa"
    images_bucket                      = "plateful-test-images"
    images_bucket_arn                  = "arn:aws:s3:::plateful-test-images"
    images_bucket_regional_domain_name = "plateful-test-images.s3.ca-west-1.amazonaws.com"
    function_name                      = "plateful-test-api"
    function_url_domain                = "abc.lambda-url.ca-west-1.on.aws"
    origin_access_control_ids          = { api = "OACAPI", pwa = "OACPWA", images = "OACIMAGES" }
  }

  # Distinct ARNs, so the function-association asserts can tell spa.js from noindex.js.
  override_resource {
    target = aws_cloudfront_function.spa
    values = { arn = "arn:aws:cloudfront::123456789012:function/plateful-test-spa" }
  }
  override_resource {
    target = aws_cloudfront_function.noindex
    values = { arn = "arn:aws:cloudfront::123456789012:function/plateful-test-noindex" }
  }

  assert {
    condition     = length(aws_cloudfront_distribution.this.custom_error_response) == 0
    error_message = "No distribution-wide custom_error_response: /api and /images errors must pass through."
  }
  assert {
    condition     = length(aws_cloudfront_distribution.this.ordered_cache_behavior) + 1 <= 5
    error_message = "The Free plan allows at most five cache behaviours."
  }
  assert {
    condition = alltrue([for b in concat(aws_cloudfront_distribution.this.ordered_cache_behavior, aws_cloudfront_distribution.this.default_cache_behavior) :
      contains([data.aws_cloudfront_cache_policy.disabled.id, data.aws_cloudfront_cache_policy.optimized.id], b.cache_policy_id) &&
      contains(["", data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id], b.origin_request_policy_id == null ? "" : b.origin_request_policy_id) &&
      contains(["", data.aws_cloudfront_response_headers_policy.security.id], b.response_headers_policy_id == null ? "" : b.response_headers_policy_id)
    ])
    error_message = "Every behaviour uses only the managed policies this module looks up: the Free plan forbids custom ones."
  }
  assert {
    condition = alltrue([for n in [
      data.aws_cloudfront_cache_policy.disabled.name, data.aws_cloudfront_cache_policy.optimized.name,
      data.aws_cloudfront_origin_request_policy.all_viewer_except_host.name,
      data.aws_cloudfront_response_headers_policy.security.name,
    ] : startswith(n, "Managed-")])
    error_message = "The policies looked up are AWS-managed ones."
  }
  assert {
    condition = alltrue([for b in concat(aws_cloudfront_distribution.this.ordered_cache_behavior, aws_cloudfront_distribution.this.default_cache_behavior) :
    anytrue([for f in b.function_association : f.event_type == "viewer-response" && f.function_arn == "arn:aws:cloudfront::123456789012:function/plateful-test-noindex"])])
    error_message = "Every behaviour runs noindex.js on viewer responses."
  }
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.this.ordered_cache_behavior :
    alltrue([for f in b.function_association : f.event_type != "viewer-request"])])
    error_message = "spa.js runs on the default behaviour only."
  }
  assert {
    condition = anytrue([for f in aws_cloudfront_distribution.this.default_cache_behavior[0].function_association :
    f.event_type == "viewer-request" && f.function_arn == "arn:aws:cloudfront::123456789012:function/plateful-test-spa"])
    error_message = "The default behaviour runs spa.js on viewer requests."
  }
  assert {
    condition = (
      { for o in aws_cloudfront_distribution.this.origin : o.origin_id => o.origin_access_control_id } ==
      { api = "OACAPI", pwa = "OACPWA", images = "OACIMAGES" }
    )
    error_message = "Each origin is locked with its own bootstrap-made OAC."
  }
}

run "store" {
  command = apply

  module {
    source = "../modules/store"
  }

  variables {
    table_name          = "plateful-test"
    images_bucket       = "plateful-test-images"
    ssm_prefix          = "/plateful/test/"
    read_capacity       = 3
    write_capacity      = 4
    deletion_protection = false
  }

  assert {
    condition = (
      aws_dynamodb_table.this.billing_mode == "PROVISIONED" &&
      aws_dynamodb_table.this.read_capacity == 3 && aws_dynamodb_table.this.write_capacity == 4
    )
    error_message = "The table is provisioned at the given capacities, so excess traffic throttles instead of billing."
  }
}

run "prod" {
  command = plan

  module {
    source = "../stacks/prod"
  }

  variables {
    lambda_zip = "main.tf" # any file: the zip's hash is all Terraform reads
  }

  override_data {
    target = module.stack.data.terraform_remote_state.bootstrap
    values = { outputs = { origin_access_control_ids = { prod = { api = "A", pwa = "P", images = "I" } } } }
  }

  assert {
    condition     = module.stack.table_capacity == { read = 10, write = 10 }
    error_message = "Prod's table is provisioned at 10 RCU and 10 WCU."
  }
}

run "staging" {
  command = plan

  module {
    source = "../stacks/staging"
  }

  variables {
    lambda_zip = "main.tf"
  }

  override_data {
    target = module.stack.data.terraform_remote_state.bootstrap
    values = { outputs = { origin_access_control_ids = { staging = { api = "A", pwa = "P", images = "I" } } } }
  }

  assert {
    condition     = module.stack.table_capacity == { read = 5, write = 5 }
    error_message = "Staging's table is provisioned at 5 RCU and 5 WCU, so both stacks stay within the free 25."
  }
}
