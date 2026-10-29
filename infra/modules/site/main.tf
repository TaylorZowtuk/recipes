# The public entry point: one CloudFront distribution per stack, with OAC on every origin, a WAF
# web ACL with one rate limit, and the PWA bucket. The OACs themselves are infra/bootstrap's. Only
# managed cache, origin request and response headers policies are used, because the CloudFront Free
# plan forbids custom ones; it also allows at most five behaviours (hosting ADR). The Free plan
# subscription itself is a manual CLI step that takes the distribution and web ACL ARNs this module
# outputs.
terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

variable "prefix" {
  description = "Name prefix for the stack's resources, for example plateful-staging."
  type        = string
}

variable "pwa_bucket" {
  type = string
}

variable "images_bucket" {
  type = string
}

variable "images_bucket_arn" {
  type = string
}

variable "images_bucket_regional_domain_name" {
  type = string
}

variable "function_name" {
  type = string
}

variable "function_url_domain" {
  type = string
}

variable "origin_access_control_ids" {
  description = "The stack's OAC IDs by origin (api, pwa, images), made by infra/bootstrap."
  type = object({
    api    = string
    pwa    = string
    images = string
  })
}

module "pwa" {
  source = "../private-bucket"
  name   = var.pwa_bucket
  # The deploy workflow replaces the bundle on every release, so `destroy` may empty it.
  force_destroy = true
}

# The AWS-managed policies, by the fixed IDs in CloudFront's managed policy docs. Fixed IDs, not
# name lookups, so the offline tests can tell the policies apart.
locals {
  caching_disabled        = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
  caching_optimized       = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  all_viewer_except_host  = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
  security_headers_policy = "67f7725c-6f97-4210-82d7-5512b31e9d03" # Managed-SecurityHeadersPolicy
}

variable "rate_limit" {
  description = "Requests per IP per 5 minutes before WAF blocks it. Two phones on one Wi-Fi polling /api/sync every 3 s make about 200; it moves together with that poll (offline cache and sync ADR)."
  type        = number
  default     = 1000
}

# One rule: an IP over the rate limit is blocked with WAF's default 403 (the Free plan allows IP
# rate limiting but no custom responses). Everything else is allowed. The Free plan requires a web
# ACL, and CLOUDFRONT-scoped ACLs must live in us-east-1.
resource "aws_wafv2_web_acl" "this" {
  provider = aws.us_east_1
  name     = var.prefix
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "rate-limit"
    priority = 0

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = false
      metric_name                = "${var.prefix}-rate-limit"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = false
    metric_name                = var.prefix
    sampled_requests_enabled   = false
  }
}

# SPA routing on the default behaviour only: a path without a file extension is an app route, so
# serve index.html. A distribution-wide custom error response would also turn the API's 403s and
# 404s into index.html.
resource "aws_cloudfront_function" "spa" {
  name    = "${var.prefix}-spa"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/spa.js")
}

# Adds X-Robots-Tag: noindex. No managed response headers policy adds it, and the Free plan forbids
# custom ones, so every behaviour runs this on viewer responses. CloudFront skips it when the origin
# returns 400 or more, so the API sets the header on its own responses too.
resource "aws_cloudfront_function" "noindex" {
  name    = "${var.prefix}-noindex"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/noindex.js")
}

locals {
  api_origin    = "api"
  pwa_origin    = "pwa"
  images_origin = "images"
}

resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  comment             = var.prefix
  default_root_object = "index.html"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  web_acl_id          = aws_wafv2_web_acl.this.arn

  origin {
    origin_id                = local.api_origin
    domain_name              = var.function_url_domain
    origin_access_control_id = var.origin_access_control_ids.api
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    origin_id                = local.pwa_origin
    domain_name              = module.pwa.regional_domain_name
    origin_access_control_id = var.origin_access_control_ids.pwa
  }

  origin {
    origin_id                = local.images_origin
    domain_name              = var.images_bucket_regional_domain_name
    origin_access_control_id = var.origin_access_control_ids.images
  }

  # Versioned reads, with every part of the key in the path: the managed policies that key on query
  # strings also forward Host, which a function URL origin rejects. No origin request policy, so no
  # cookie or viewer Host reaches the API: a cached read can't depend on who asked, and the function
  # URL gets its own host. The 1 s minimum TTL caches FastAPI's no-store redirects and errors for up
  # to 1 s; a 502 or 504 from Lambda or the Web Adapter has no Cache-Control, so CloudFront caches it
  # for its default 10 s error caching minimum TTL.
  ordered_cache_behavior {
    path_pattern               = "/api/v/*"
    target_origin_id           = local.api_origin
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.caching_optimized
    response_headers_policy_id = local.security_headers_policy

    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.noindex.arn
    }
  }

  # The rest of the API, uncached, with the viewer's cookies and headers but not its Host.
  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = local.api_origin
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.caching_disabled
    origin_request_policy_id   = local.all_viewer_except_host
    response_headers_policy_id = local.security_headers_policy

    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.noindex.arn
    }
  }

  # Images have content-hashed keys and never change.
  ordered_cache_behavior {
    path_pattern               = "/images/*"
    target_origin_id           = local.images_origin
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.caching_optimized
    response_headers_policy_id = local.security_headers_policy

    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.noindex.arn
    }
  }

  default_cache_behavior {
    target_origin_id           = local.pwa_origin
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.caching_optimized
    response_headers_policy_id = local.security_headers_policy

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }

    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.noindex.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# The function URL accepts only this distribution. OAC to a function URL needs both permissions.
resource "aws_lambda_permission" "invoke_url" {
  statement_id           = "CloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = var.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.this.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "invoke" {
  statement_id             = "CloudFrontInvokeFunction"
  action                   = "lambda:InvokeFunction"
  function_name            = var.function_name
  principal                = "cloudfront.amazonaws.com"
  source_arn               = aws_cloudfront_distribution.this.arn
  invoked_via_function_url = true
}

# Each bucket is readable only by this distribution, through OAC.
data "aws_iam_policy_document" "bucket" {
  for_each = {
    pwa    = module.pwa.arn
    images = var.images_bucket_arn
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${each.value}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "pwa" {
  bucket = module.pwa.name
  policy = data.aws_iam_policy_document.bucket["pwa"].json
}

resource "aws_s3_bucket_policy" "images" {
  bucket = var.images_bucket
  policy = data.aws_iam_policy_document.bucket["images"].json
}

output "pwa_bucket" {
  value = module.pwa.name
}

output "pwa_bucket_arn" {
  value = module.pwa.arn
}

output "distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  value = aws_cloudfront_distribution.this.arn
}

output "distribution_domain" {
  value = aws_cloudfront_distribution.this.domain_name
}

output "web_acl_arn" {
  value = aws_wafv2_web_acl.this.arn
}
