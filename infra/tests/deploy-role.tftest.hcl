# The deploy role's CloudFront grants. Create calls have no resource type, so they only match
# "*"; tagging a distribution needs this stack's Stack tag both on the request and on any
# existing distribution, so one stack's role can't retag another stack's distribution.

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

run "cloudfront_grants" {
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
      toset(flatten([({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).DistributionCreate.Action])) == toset(["cloudfront:CreateDistribution"]) &&
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).DistributionCreate.Condition == { StringEquals = { "aws:RequestTag/Stack" = "staging" } }
    )
    error_message = "CreateDistribution is granted on \"*\", only with this stack's Stack request tag."
  }
  assert {
    condition = (
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).CloudFrontCreate.Resource == "*" &&
      toset(flatten([({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).CloudFrontCreate.Action])) == toset(["cloudfront:CreateFunction", "cloudfront:CreateOriginAccessControl"]) &&
      !can(({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).CloudFrontCreate.Condition)
    )
    error_message = "CreateFunction and CreateOriginAccessControl are granted on \"*\"."
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
    condition     = contains(flatten([({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).CloudFrontNamed.Resource]), "arn:aws:cloudfront::123456789012:function/plateful-staging-*")
    error_message = "Function updates, publishes and deletes stay on the stack's prefix."
  }
  assert {
    condition = alltrue([for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : !contains(flatten([s.Action]), "cloudfront:TagResource")
    if s.Sid != "DistributionTag" && s.Sid != "Distribution" && s.Sid != "CloudFrontNamed"])
    error_message = "Only the tag-checked statements may grant TagResource."
  }
}
