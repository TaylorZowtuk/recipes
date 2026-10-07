# The prod stack. Its resources arrive with the Terraform stacks and deploy workflows ticket.
terraform {
  required_version = "~> 1.16" # the toolchain image pins the exact version (docker/Dockerfile)
}
