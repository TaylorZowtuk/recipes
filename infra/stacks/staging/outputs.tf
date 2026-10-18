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

output "table_name" {
  value = module.stack.table_name
}

output "deploy_role_arn" {
  value = module.stack.deploy_role_arn
}

output "dev_user" {
  value = module.dev_user.name
}
