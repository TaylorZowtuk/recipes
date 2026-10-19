# A stack's CloudFront origin access controls: one for the API's function URL and one per bucket.
# infra/bootstrap makes them, not the stack: OACs have generated IDs and carry no tags, so a deploy
# role could only be given them account-wide. The stack reads their IDs from bootstrap's state.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "names" {
  description = "OAC names by origin (api, pwa, images), from stack-access."
  type = object({
    api    = string
    pwa    = string
    images = string
  })
}

locals {
  origin_types = {
    api    = "lambda"
    pwa    = "s3"
    images = "s3"
  }
}

resource "aws_cloudfront_origin_access_control" "this" {
  for_each                          = local.origin_types
  name                              = var.names[each.key]
  origin_access_control_origin_type = each.value
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

output "ids" {
  description = "OAC IDs by origin: api, pwa and images."
  value       = { for k, oac in aws_cloudfront_origin_access_control.this : k => oac.id }
}
