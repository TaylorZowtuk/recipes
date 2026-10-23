# The account's one-time setup, applied by a human with temporary admin credentials (see
# infra/AGENTS.md): the Terraform state bucket, GitHub's OIDC provider, the account's spend alarm,
# and each stack's deploy role, permissions boundary and CloudFront OACs. Its own state lives in
# the state bucket under bootstrap/.
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
    region       = "us-west-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-west-2"
  default_tags {
    tags = {
      Project = "plateful"
      Stack   = "bootstrap"
    }
  }
}

# Billing metrics, and so the spend alarm, exist only in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project = "plateful"
      Stack   = "bootstrap"
    }
  }
}

# The repository uses GitHub's immutable OIDC subject, which names the owner and repository by name
# and ID, so a renamed or re-created repository can't assume the roles. Read it with
# gh api repos/TaylorZowtuk/recipes/actions/oidc/customization/sub --jq .sub_claim_prefix
variable "github_subject_prefix" {
  description = "The repository part of the OIDC sub claim of the GitHub repository whose workflows deploy."
  type        = string
  default     = "repo:TaylorZowtuk@43101199/recipes@1386669274"
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

# Versioned, so an overwritten or deleted state can be recovered. The name comes from stack-access
# (the same for every stack), where each stack's terraform_remote_state gets it too.
module "state" {
  source    = "../modules/private-bucket"
  name      = one(distinct([for m in module.access : m.state_bucket]))
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
  subject_prefix    = var.github_subject_prefix
  oidc_provider_arn = aws_iam_openid_connect_provider.github.arn
  state_bucket      = module.state.name
}

module "access" {
  source     = "../modules/stack-access"
  for_each   = var.stacks
  stack      = each.key
  account_id = local.account_id
  region     = data.aws_region.current.region
}

module "origin_access" {
  source   = "../modules/origin-access"
  for_each = var.stacks
  names    = module.access[each.key].oac_names
}

# The account-wide $1-a-month budget and billing alarm, and the topic they send to. Bootstrap, not
# the stacks, subscribes each stack's kill switch to it, so no deploy role needs any grant on the
# topic: SNS can't scope a subscription call to one stack's subscription.
module "spend_alarm" {
  source           = "../modules/spend-alarm"
  providers        = { aws = aws.us_east_1 }
  account_id       = local.account_id
  kill_switch_arns = { for s, m in module.access : s => m.kill_switch_arn }
}

output "state_bucket" {
  value = module.state.name
}

output "deploy_role_arns" {
  value = { for s, m in module.deploy_role : s => m.role_arn }
}

output "origin_access_control_ids" {
  description = "Each stack's OAC IDs by origin, read by the stack through terraform_remote_state."
  value       = { for s, m in module.origin_access : s => m.ids }
}

output "spend_alarm_topic_arn" {
  description = "The account's spend alarm topic, read by each stack through terraform_remote_state."
  value       = module.spend_alarm.topic_arn
}
