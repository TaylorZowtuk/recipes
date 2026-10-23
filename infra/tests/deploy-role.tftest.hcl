# The deploy role's CloudFront and state grants. Create calls have no resource type, so they only
# match "*"; tagging a distribution needs this stack's Stack tag both on the request and on any
# existing distribution, so one stack's role can't retag another stack's distribution. OACs
# belong to infra/bootstrap, so the role may only read them. Only a job in the stack's GitHub
# environment may assume it, matched on the immutable OIDC subject GitHub sends.

# A real but unauthenticated provider: aws_iam_policy_document renders locally, so the test checks
# the policy JSON IAM would get, and the overridden resources make no calls.
provider "aws" {
  region                      = "us-west-2"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

variables {
  stack             = "staging"
  account_id        = "123456789012"
  region            = "us-west-2"
  subject_prefix    = "repo:owner@1/repo@2"
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
      one(jsondecode(data.aws_iam_policy_document.trust.json).Statement).Condition.StringEquals == {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "repo:owner@1/repo@2:environment:staging"
      }
    )
    error_message = "Only a job in the stack's GitHub environment, with the repository's immutable subject, may assume the role."
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
  # Outside the scoped statements, the role may only read CloudFront: any write there (Untag,
  # UpdateDistribution, a ? wildcard) would reach the other stack's distribution or functions.
  assert {
    condition = alltrue([for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : alltrue([
      for a in flatten([s.Action]) : !startswith(lower(a), "cloudfront:") || can(regex("^cloudfront:(get|list|describe)", lower(a)))
    ]) if !contains(["Distribution", "DistributionCreate", "DistributionTag", "EdgeFunction", "EdgeFunctionCreate"], s.Sid)])
    error_message = "Outside the stack-scoped CloudFront statements, the deploy role only reads CloudFront."
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
  assert {
    condition = alltrue([for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : !(
      anytrue([for r in flatten([s.Resource]) : anytrue([for k in ["prod/terraform.tfstate", "bootstrap/terraform.tfstate"] :
      can(regex("^${replace(r, "*", ".*")}$", "arn:aws:s3:::plateful-tfstate-123456789012/${k}"))])]) &&
      anytrue([for a in flatten([s.Action]) : can(regex("^${replace(lower(a), "*", ".*")}$", "s3:putobject"))])
    )])
    error_message = "No statement lets the staging role write prod's or bootstrap's state, wildcards included."
  }
  assert {
    condition     = toset(flatten([({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).State.Action])) == toset(["s3:GetObject", "s3:PutObject"])
    error_message = "The deploy role reads and writes its state key, and never deletes it."
  }
  # The kill switch: the stack's own kill-switch role carries the boundary, so the boundary must
  # let it throttle the stack's API, and only that.
  assert {
    condition = (
      toset(flatten([({ for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s.Sid => s }).KillSwitch.Action])) ==
      toset(["lambda:PutFunctionConcurrency", "lambda:GetFunctionConcurrency"]) &&
      ({ for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s.Sid => s }).KillSwitch.Resource == "arn:aws:lambda:us-west-2:123456789012:function:plateful-staging-api"
    )
    error_message = "The boundary lets the stack's roles set the concurrency of the stack's API function and no other."
  }
  assert {
    condition = alltrue([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : !(
      anytrue([for r in flatten([s.Resource]) : can(regex("^${replace(r, "*", ".*")}$", "arn:aws:lambda:us-west-2:123456789012:function:plateful-prod-api"))])
    )])
    error_message = "No boundary statement reaches the other stack's API function."
  }
  assert {
    condition = toset(flatten([({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).Function.Resource])) == toset([
      "arn:aws:lambda:us-west-2:123456789012:function:plateful-staging-*",
      "arn:aws:lambda:us-west-2:123456789012:function:plateful-staging-*:*",
    ])
    error_message = "The deploy role manages every function with the stack's prefix: the API and the kill switch."
  }
  assert {
    condition = (
      contains(flatten([({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).Topic.Action]), "sns:Publish") &&
      ({ for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : s.Sid => s }).Topic.Resource == "arn:aws:sns:us-west-2:123456789012:plateful-staging-*"
    )
    error_message = "The deploy role manages SNS topics with the stack's prefix, in the stack's region, and may publish to them."
  }
  # AddPermission would let the role give anyone publish rights on the stack's kill-switch topic.
  assert {
    condition = alltrue([for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : !anytrue([
      for a in flatten([s.Action]) : anytrue([for op in ["addpermission", "removepermission"] :
      can(regex("^${replace(lower(a), "*", ".*")}$", "sns:${op}"))])
    ])])
    error_message = "No statement grants sns:AddPermission or sns:RemovePermission, wildcards included."
  }
  # The account's spend alarm topic and its subscriptions belong to infra/bootstrap. SNS can't scope
  # a subscription call to one stack's subscription, so any grant there would let one stack
  # unsubscribe the other's kill switch; publishing would trip every stack. No statement may grant
  # any SNS action on the topic or a subscription to it, wildcards included.
  assert {
    condition = alltrue([for s in jsondecode(data.aws_iam_policy_document.deploy.json).Statement : !(
      anytrue([for r in flatten([s.Resource]) : anytrue([for arn in [
        "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm",
        "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      ] : can(regex("^${replace(r, "*", ".*")}$", arn))])]) &&
      anytrue([for a in flatten([s.Action]) : a == "*" || startswith(lower(a), "sns:")])
    )])
    error_message = "No deploy-role statement names the account's spend alarm topic or its subscriptions."
  }
}
