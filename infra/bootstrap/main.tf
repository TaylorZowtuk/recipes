# The account's one-time setup, applied by a human with temporary admin credentials (see
# infra/AGENTS.md): the Terraform state bucket, GitHub's OIDC provider, and each stack's deploy
# role and permissions boundary. Its own state lives in the state bucket under bootstrap/.
# After the first apply, init with:
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
    key          = "bootstrap/terraform.tfstate"
    region       = "ca-west-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "ca-west-1"
  default_tags {
    tags = {
      Project = "plateful"
      Stack   = "bootstrap"
    }
  }
}

variable "repository" {
  description = "The GitHub repository whose workflows deploy."
  type        = string
  default     = "TaylorZowtuk/recipes"
}

variable "stacks" {
  description = "Stacks to make deploy roles for. Each is also the GitHub environment its deploy job runs in."
  type        = set(string)
  default     = ["prod", "staging"]
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
}

# Versioned, so an overwritten or deleted state can be recovered.
module "state" {
  source    = "../modules/private-bucket"
  name      = "plateful-tfstate-${local.account_id}"
  versioned = true
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

module "deploy_role" {
  source            = "../modules/github-deploy-role"
  for_each          = var.stacks
  stack             = each.key
  account_id        = local.account_id
  region            = data.aws_region.current.region
  repository        = var.repository
  oidc_provider_arn = aws_iam_openid_connect_provider.github.arn
  state_bucket      = module.state.name
}

output "state_bucket" {
  value = module.state.name
}

output "deploy_role_arns" {
  value = { for s, m in module.deploy_role : s => m.role_arn }
}
