# The root `terraform test` runs from. It has no resources of its own: each run block in the
# *.tftest.hcl files here loads one module or stack and checks it offline, against mock or
# unconfigured providers, so `make check` never needs AWS credentials.
terraform {
  required_version = "~> 1.16" # the toolchain image pins the exact version (docker/Dockerfile)

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
  }
}
