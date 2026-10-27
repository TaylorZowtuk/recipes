# The Free plan and capacity rules (hosting and stacks ADRs), checked offline against mock
# providers: provisioned DynamoDB at the stacks' capacities, managed CloudFront policies only, at
# most five behaviours, a cached /api/v/* ahead of /api/* with no origin request policy, no
# distribution-wide error responses, noindex.js on every behaviour, spa.js on the default one
# only, and the bootstrap-made OAC on every origin. Also the spend guard:
# the API's reserved concurrency, the WAF rate limit, the kill switch's wiring in each stack, and
# bootstrap's subscription of each stack's kill switch to the account's spend alarm topic.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-west-2" }
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
    defaults = { arn = "arn:aws:logs:us-west-2:123456789012:log-group:mock" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-west-2:123456789012:function:mock" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-west-2:123456789012:mock" }
  }
  mock_resource "aws_lambda_function_url" {
    defaults = { function_url = "https://abc.lambda-url.us-west-2.on.aws/" }
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
    images_bucket_regional_domain_name = "plateful-test-images.s3.us-west-2.amazonaws.com"
    function_name                      = "plateful-test-api"
    function_url_domain                = "abc.lambda-url.us-west-2.on.aws"
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
    condition = try(
      index(aws_cloudfront_distribution.this.ordered_cache_behavior[*].path_pattern, "/api/v/*") <
      index(aws_cloudfront_distribution.this.ordered_cache_behavior[*].path_pattern, "/api/*"),
    false)
    error_message = "A /api/v/* behaviour comes before /api/*, so versioned reads are cached."
  }
  assert {
    condition = length([for b in aws_cloudfront_distribution.this.ordered_cache_behavior : b if
      b.path_pattern == "/api/v/*" && b.target_origin_id == "api" &&
      toset(b.allowed_methods) == toset(["GET", "HEAD"]) && toset(b.cached_methods) == toset(["GET", "HEAD"]) &&
      b.cache_policy_id == data.aws_cloudfront_cache_policy.optimized.id &&
      b.response_headers_policy_id == data.aws_cloudfront_response_headers_policy.security.id &&
      anytrue([for f in b.function_association : f.event_type == "viewer-response" && f.function_arn == "arn:aws:cloudfront::123456789012:function/plateful-test-noindex"])
    ]) == 1
    error_message = "/api/v/* reads the API with GET and HEAD only, on Managed-CachingOptimized, the security headers policy and noindex.js."
  }
  assert {
    condition = alltrue([for b in aws_cloudfront_distribution.this.ordered_cache_behavior :
    b.origin_request_policy_id == null || b.origin_request_policy_id == "" if b.path_pattern == "/api/v/*"])
    error_message = "/api/v/* has no origin request policy: no cookie or viewer Host may reach the API."
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
  assert {
    condition = (
      length(aws_wafv2_web_acl.this.rule) == 1 &&
      one(aws_wafv2_web_acl.this.rule[*].statement[0].rate_based_statement[0].limit) == 1000 &&
      one(aws_wafv2_web_acl.this.rule[*].statement[0].rate_based_statement[0].evaluation_window_sec) == 300 &&
      one(aws_wafv2_web_acl.this.rule[*].statement[0].rate_based_statement[0].aggregate_key_type) == "IP" &&
      length(one(aws_wafv2_web_acl.this.rule[*].action[0].block)) == 1
    )
    error_message = "One WAF rule blocks an IP over 1,000 requests per 5 minutes, above the phones' 3 s sync poll."
  }
  assert {
    condition     = length(aws_wafv2_web_acl.this.rule) <= 5
    error_message = "The Free plan allows at most five WAF rules."
  }
}

run "api" {
  command = apply

  module {
    source = "../modules/api"
  }

  variables {
    function_name            = "plateful-test-api"
    zip_path                 = "main.tf"
    runtime                  = "python3.14"
    lwa_layer_arn            = "arn:aws:lambda:us-west-2:753240598075:layer:LambdaAdapterLayerArm64:30"
    environment              = {}
    data_policy_json         = "{}"
    permissions_boundary_arn = "arn:aws:iam::123456789012:policy/plateful-test-boundary"
    reserved_concurrency     = 3
  }

  assert {
    condition     = aws_lambda_function.this.reserved_concurrent_executions == 3
    error_message = "The API reserves, and is capped at, the given concurrency."
  }
}

run "kill_switch" {
  command = apply

  module {
    source = "../modules/kill-switch"
  }

  variables {
    name                     = "plateful-test-kill-switch"
    zip_path                 = "main.tf"
    runtime                  = "python3.14"
    api_function_name        = "plateful-test-api"
    api_function_arn         = "arn:aws:lambda:us-west-2:123456789012:function:plateful-test-api"
    account_topic_arn        = "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm"
    permissions_boundary_arn = "arn:aws:iam::123456789012:policy/plateful-test-boundary"
  }

  override_resource {
    target = aws_lambda_function.this
    values = { arn = "arn:aws:lambda:us-west-2:123456789012:function:plateful-test-kill-switch" }
  }
  override_resource {
    target = aws_sns_topic.stack
    values = { arn = "arn:aws:sns:us-west-2:123456789012:plateful-test-kill-switch" }
  }

  assert {
    condition = (
      aws_lambda_function.this.handler == "recipes.kill_switch.handler" &&
      aws_lambda_function.this.layers == null &&
      aws_lambda_function.this.environment[0].variables["API_FUNCTION_NAME"] == "plateful-test-api"
    )
    error_message = "The kill switch runs the plain Python handler from the API's zip, aimed at the API."
  }
  assert {
    condition     = output.wiring.api_function_arns == ["arn:aws:lambda:us-west-2:123456789012:function:plateful-test-api"]
    error_message = "The kill switch may set the concurrency of the API's function only."
  }
  assert {
    condition     = aws_iam_role.this.permissions_boundary == "arn:aws:iam::123456789012:policy/plateful-test-boundary"
    error_message = "The kill switch's role carries the stack's permissions boundary."
  }
  assert {
    condition = (
      aws_sns_topic_subscription.stack.topic_arn == "arn:aws:sns:us-west-2:123456789012:plateful-test-kill-switch" &&
      aws_sns_topic_subscription.stack.protocol == "lambda" &&
      aws_sns_topic_subscription.stack.endpoint == "arn:aws:lambda:us-west-2:123456789012:function:plateful-test-kill-switch"
    )
    error_message = "The kill switch is subscribed to the stack's topic; infra/bootstrap subscribes it to the account's."
  }
  assert {
    condition = (
      toset([for p in aws_lambda_permission.sns : p.source_arn]) == toset([
        "arn:aws:sns:us-west-2:123456789012:plateful-test-kill-switch",
        "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm",
      ]) &&
      alltrue([for p in aws_lambda_permission.sns :
      p.principal == "sns.amazonaws.com" && p.action == "lambda:InvokeFunction" && p.function_name == "plateful-test-kill-switch"])
    )
    error_message = "Each topic, and only those, may invoke the kill switch."
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
  assert {
    condition = toset(keys(aws_ssm_parameter.secret)) == toset([
      "editor-allowlist", "session-hmac-key", "service-token-hash", "google-client-id",
    ])
    error_message = "The store holds the four sign-in parameters the API reads."
  }
  assert {
    condition = alltrue([
      for k, p in aws_ssm_parameter.secret :
      p.name == "/plateful/test/${k}" && p.type == "SecureString" && p.value_wo_version == 1
    ])
    error_message = "Each sign-in parameter sits under the stack's prefix, written once as a placeholder (version 1) that Terraform never reverts."
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
    values = { outputs = {
      origin_access_control_ids = { prod = { api = "A", pwa = "P", images = "I" } }
      spend_alarm_topic_arn     = "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm"
    } }
  }
  override_resource {
    target          = module.stack.module.api.aws_lambda_function.this
    values          = { arn = "arn:aws:lambda:us-west-2:123456789012:function:plateful-prod-api" }
    override_during = plan
  }

  assert {
    condition     = module.stack.table_capacity == { read = 10, write = 10 }
    error_message = "Prod's table is provisioned at 10 RCU and 10 WCU."
  }
  assert {
    condition = (
      module.stack.api_reserved_concurrency == 3 &&
      module.stack.api_applied_reserved_concurrency == 3
    )
    error_message = "The API reserves 3 concurrent executions by default (hosting ADR)."
  }
  assert {
    condition = (
      module.stack.kill_switch.api_function_name == "plateful-prod-api" &&
      module.stack.kill_switch.function_name == "plateful-prod-kill-switch" && # the name bootstrap subscribes
      module.stack.kill_switch.api_function_arns == ["arn:aws:lambda:us-west-2:123456789012:function:plateful-prod-api"]
    )
    error_message = "Prod's kill switch, plateful-prod-kill-switch, throttles prod's API, and may set only its concurrency."
  }
  assert {
    condition     = module.stack.kill_switch.topic_arns["account"] == "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm"
    error_message = "The account's spend alarm topic, from bootstrap's state, may invoke prod's kill switch."
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
    values = { outputs = {
      origin_access_control_ids = { staging = { api = "A", pwa = "P", images = "I" } }
      spend_alarm_topic_arn     = "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm"
    } }
  }

  assert {
    condition     = module.stack.table_capacity == { read = 5, write = 5 }
    error_message = "Staging's table is provisioned at 5 RCU and 5 WCU, so both stacks stay within the free 25."
  }
  assert {
    condition     = module.stack.kill_switch.api_function_name == "plateful-staging-api"
    error_message = "Staging's kill switch throttles staging's API."
  }
}

# A deploy while the kill switch is tripped (scripts/deploy.sh) keeps the API at 0, and still
# reports the configured value for the reset to restore.
run "staging_tripped" {
  command = plan

  module {
    source = "../stacks/staging"
  }

  variables {
    lambda_zip          = "main.tf"
    kill_switch_tripped = true
  }

  override_data {
    target = module.stack.data.terraform_remote_state.bootstrap
    values = { outputs = {
      origin_access_control_ids = { staging = { api = "A", pwa = "P", images = "I" } }
      spend_alarm_topic_arn     = "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm"
    } }
  }

  assert {
    condition     = module.stack.api_applied_reserved_concurrency == 0
    error_message = "kill_switch_tripped = true keeps the API at 0 reserved concurrency."
  }
  assert {
    condition     = module.stack.api_reserved_concurrency == 3
    error_message = "The output stays the configured value while tripped, so the reset has something to restore."
  }
}

run "prod_tripped" {
  command = plan

  module {
    source = "../stacks/prod"
  }

  variables {
    lambda_zip          = "main.tf"
    kill_switch_tripped = true
  }

  override_data {
    target = module.stack.data.terraform_remote_state.bootstrap
    values = { outputs = {
      origin_access_control_ids = { prod = { api = "A", pwa = "P", images = "I" } }
      spend_alarm_topic_arn     = "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm"
    } }
  }

  assert {
    condition     = module.stack.api_applied_reserved_concurrency == 0 && module.stack.api_reserved_concurrency == 3
    error_message = "Prod passes kill_switch_tripped through: the API stays at 0 and the output stays 3."
  }
}

# Bootstrap subscribes each stack's kill switch to the account's spend alarm topic, at the ARN
# stack-access builds for it (the region is mocked here; the wizard's check_kill_switches confirms
# it on AWS).
run "bootstrap" {
  command = plan

  module {
    source = "../bootstrap"
  }

  assert {
    condition = (
      module.spend_alarm.kill_switch_endpoints == {
        prod    = "arn:aws:lambda:us-west-2:123456789012:function:plateful-prod-kill-switch"
        staging = "arn:aws:lambda:us-west-2:123456789012:function:plateful-staging-kill-switch"
      }
    )
    error_message = "Bootstrap subscribes both stacks' kill-switch functions, at their real ARNs, to the account topic."
  }
}
