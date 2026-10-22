output "distribution_domain" {
  value = module.stack.distribution_domain
}

output "distribution_id" {
  value = module.stack.distribution_id
}

output "distribution_arn" {
  description = "For the CloudFront Free plan subscription step."
  value       = module.stack.distribution_arn
}

output "web_acl_arn" {
  description = "For the CloudFront Free plan subscription step."
  value       = module.stack.web_acl_arn
}

output "pwa_bucket" {
  value = module.stack.pwa_bucket
}

output "images_bucket" {
  value = module.stack.images_bucket
}

output "function_name" {
  value = module.stack.function_name
}

output "api_function_name" {
  value = module.stack.api_function_name
}

output "api_reserved_concurrency" {
  description = "The value to restore the API's reserved concurrency to after the kill switch trips."
  value       = module.stack.api_reserved_concurrency
}

output "kill_switch_topic_arn" {
  description = "Publishing to this topic trips only this stack's kill switch."
  value       = module.stack.kill_switch_topic_arn
}

output "table_name" {
  value = module.stack.table_name
}

output "deploy_role_arn" {
  value = module.stack.deploy_role_arn
}
