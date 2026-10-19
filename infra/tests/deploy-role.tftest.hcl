# The deploy role's CloudFront and state grants. Create calls have no resource type, so they only
# match "*"; tagging a distribution needs this stack's Stack tag both on the request and on any
# existing distribution, so one stack's role can't retag another stack's distribution. OACs
# belong to infra/bootstrap, so the role may only read them.

# A real but unauthenticated provider: aws_iam_policy_document renders locally, so the test checks
# the policy JSON IAM would get, and the overridden resources make no calls.
provider "aws" {
  region                      = "ca-west-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

variables {
  stack             = "staging"
  account_id        = "123456789012"
  region            = "ca-west-1"
  repository        = "owner/repo"
  oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  state_bucket      = "plateful-tfstate-123456789012"
}

run "deploy_policy" {
  command = apply # every resource is overridden, so nothing reaches AWS

  module {
    source = "../modules/github-deploy-role"
  }

  override_resource {
    target = aws_iam_policy.boundary
    values = { arn = "arn:aws:iam::123456789012:policy/plateful-staging-boundary" }
  }
  override_resource {
    target = aws_iam_role.deploy
  }
  override_resource {
    target = aws_iam_role_policy.deploy
  }

  assert {
    condition = (
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).DistributionCreate.Resource == "*" &&
      flatten([({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).DistributionCreate.Action]) == ["cloudfront:CreateDistribution"] &&
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).DistributionCreate.Condition == { StringEquals = { "aws:RequestTag/Stack" = "staging" } }
    )
    error_message = "CreateDistribution is granted on \"*\", only with this stack's Stack request tag."
  }
  assert {
    condition = (
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).EdgeFunctionCreate.Resource == "*" &&
      flatten([({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).EdgeFunctionCreate.Action]) == ["cloudfront:CreateFunction"] &&
      !can(({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).EdgeFunctionCreate.Condition)
    )
    error_message = "CreateFunction is granted on \"*\"."
  }
  assert {
    condition = (
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).DistributionTag.Resource == "arn:aws:cloudfront::123456789012:distribution/*" &&
      flatten([({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).DistributionTag.Action]) == ["cloudfront:TagResource"] &&
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).DistributionTag.Condition == {
        StringEquals         = { "aws:RequestTag/Stack" = "staging" }
        StringEqualsIfExists = { "aws:ResourceTag/Stack" = "staging" }
      }
    )
    error_message = "TagResource on distributions needs this stack's Stack tag on the request and on any existing distribution."
  }
  assert {
    condition = (
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).Distribution.Resource == "arn:aws:cloudfront::123456789012:distribution/*" &&
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).Distribution.Condition == { StringEquals = { "aws:ResourceTag/Stack" = "staging" } }
    )
    error_message = "Every other distribution call, UntagResource included, needs this stack's Stack tag on the distribution."
  }
  assert {
    condition     = ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).EdgeFunction.Resource == "arn:aws:cloudfront::123456789012:function/plateful-staging-*"
    error_message = "Function updates, publishes and deletes stay on the stack's prefix."
  }
  # Each granted action and resource is a glob, so these turn it into a regex and test it against
  # the names it could cover: cloudfront:Tag* or cloudfront:* grants TagResource as much as the
  # literal name does.
  assert {
    condition = alltrue([for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : !anytrue([
      for a in flatten([s.Action]) : can(regex("^${replace(lower(a), "*", ".*")}$", "cloudfront:tagresource"))
    ]) if !contains(["DistributionTag", "Distribution", "EdgeFunction"], s.Sid)])
    error_message = "Only the tag-checked statements and the stack's own functions may grant TagResource, wildcards included."
  }
  assert {
    condition = alltrue([for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : !(
      anytrue([for r in flatten([s.Resource]) : can(regex("^${replace(r, "*", ".*")}$", "arn:aws:cloudfront::123456789012:origin-access-control/E1"))]) &&
      anytrue([for a in flatten([s.Action]) : anytrue([for op in ["create", "update", "delete"] :
        can(regex("^${replace(lower(a), "*", ".*")}$", "cloudfront:${op}originaccesscontrol"))
      ])])
    )])
    error_message = "OACs belong to infra/bootstrap: no statement may create, update or delete one, wildcards included."
  }
  assert {
    condition = (
      flatten([({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).BootstrapState.Action]) == ["s3:GetObject"] &&
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).BootstrapState.Resource == "arn:aws:s3:::plateful-tfstate-123456789012/bootstrap/terraform.tfstate"
    )
    error_message = "The deploy role reads bootstrap's state, for the stack's OAC IDs, and nothing else of it."
  }
  assert {
    condition = (
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).State.Resource == "arn:aws:s3:::plateful-tfstate-123456789012/staging/terraform.tfstate" &&
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).StateLock.Resource == "arn:aws:s3:::plateful-tfstate-123456789012/staging/terraform.tfstate.tflock"
    )
    error_message = "The deploy role writes only its own stack's state key and lock file."
  }
}
