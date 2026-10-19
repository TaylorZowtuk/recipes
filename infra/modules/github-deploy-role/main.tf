# A stack's GitHub Actions deploy role and the permissions boundary every IAM role and user in that
# stack must carry. infra/bootstrap makes them, not the stack itself, so a deploy can't widen its
# own permissions. Only a workflow job running in the stack's GitHub environment can assume it, and
# it can change only that stack's resources (named with the stack-access prefix) and state key.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "stack" {
  type = string
}

variable "account_id" {
  type = string
}

variable "region" {
  type = string
}

variable "repository" {
  description = "owner/name of the GitHub repository."
  type        = string
}

variable "oidc_provider_arn" {
  type = string
}

variable "state_bucket" {
  type = string
}

module "access" {
  source     = "../stack-access"
  stack      = var.stack
  account_id = var.account_id
  region     = var.region
}

locals {
  prefix    = module.access.prefix
  acct      = var.account_id
  region    = var.region
  state_key = "${var.stack}/terraform.tfstate"
}

# The boundary: the most any role or user the stack makes may ever do (its data plus its logs).
data "aws_iam_policy_document" "boundary" {
  source_policy_documents = [module.access.data_policy_json]

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${local.region}:${local.acct}:log-group:/aws/lambda/${local.prefix}-*:*"]
  }
}

resource "aws_iam_policy" "boundary" {
  name        = module.access.boundary_name
  description = "Permissions boundary for every IAM role and user in the ${var.stack} stack."
  policy      = data.aws_iam_policy_document.boundary.json
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.repository}:environment:${var.stack}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = module.access.deploy_role_name
  description        = "GitHub Actions deploys of the ${var.stack} stack."
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "deploy" {
  # Unconditioned: without ListBucket, S3 answers a read of the not-yet-written state with 403, not
  # 404, and `init` lists workspaces under env:/. Object reads and writes stay on this stack's key.
  statement {
    sid       = "StateList"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.state_bucket}"]
  }

  statement {
    sid       = "State"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["arn:aws:s3:::${var.state_bucket}/${local.state_key}"]
  }

  # The stack reads its OAC IDs from bootstrap's outputs. OACs carry no tags and have generated
  # IDs, so bootstrap owns them and the deploy role can only read them (CloudFrontRead).
  statement {
    sid       = "BootstrapState"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.state_bucket}/${module.access.bootstrap_state_key}"]
  }

  statement {
    sid       = "StateLock"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.state_bucket}/${local.state_key}.tflock"]
  }

  statement {
    sid       = "Table"
    actions   = ["dynamodb:*"]
    resources = ["arn:aws:dynamodb:${local.region}:${local.acct}:table/${module.access.table_name}"]
  }

  statement {
    sid     = "Buckets"
    actions = ["s3:*"]
    resources = flatten([for b in [module.access.pwa_bucket, module.access.images_bucket] : [
      "arn:aws:s3:::${b}", "arn:aws:s3:::${b}/*",
    ]])
  }

  statement {
    sid     = "Secrets"
    actions = ["ssm:*"]
    resources = [
      "arn:aws:ssm:${local.region}:${local.acct}:parameter/plateful/${var.stack}",
      "arn:aws:ssm:${local.region}:${local.acct}:parameter/plateful/${var.stack}/*",
    ]
  }

  statement {
    sid       = "SecretsKey"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:DescribeKey"]
    resources = ["arn:aws:kms:${local.region}:${local.acct}:key/*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${local.region}.amazonaws.com"]
    }
  }

  statement {
    sid     = "Function"
    actions = ["lambda:*"]
    resources = [
      "arn:aws:lambda:${local.region}:${local.acct}:function:${module.access.function_name}",
      "arn:aws:lambda:${local.region}:${local.acct}:function:${module.access.function_name}:*",
    ]
  }

  statement {
    sid       = "AdapterLayer"
    actions   = ["lambda:GetLayerVersion"]
    resources = ["arn:aws:lambda:${local.region}:*:layer:*:*"]
  }

  statement {
    sid     = "Logs"
    actions = ["logs:*"]
    resources = [
      "arn:aws:logs:${local.region}:${local.acct}:log-group:/aws/lambda/${local.prefix}-*",
      "arn:aws:logs:${local.region}:${local.acct}:log-group:/aws/lambda/${local.prefix}-*:*",
    ]
  }

  # IAM: only roles and users with the stack's prefix, and only while they carry its boundary.
  # No access keys: the dev user's key is made by hand.
  statement {
    sid = "IamManage"
    actions = [
      "iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole", "iam:ListRoleTags",
      "iam:GetUser", "iam:GetUserPolicy", "iam:ListUserPolicies", "iam:ListAttachedUserPolicies",
      "iam:ListAccessKeys", "iam:ListGroupsForUser", "iam:ListMFADevices", "iam:ListSigningCertificates",
      "iam:ListSSHPublicKeys", "iam:ListServiceSpecificCredentials", "iam:GetLoginProfile", "iam:ListUserTags",
      "iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DeleteUser", "iam:DeleteUserPolicy",
      "iam:TagRole", "iam:UntagRole", "iam:TagUser", "iam:UntagUser", "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole", "iam:UpdateRoleDescription",
    ]
    resources = [
      "arn:aws:iam::${local.acct}:role/${local.prefix}-*",
      "arn:aws:iam::${local.acct}:user/${local.prefix}-*",
    ]
  }

  statement {
    sid = "IamWithinBoundary"
    actions = [
      "iam:CreateRole", "iam:PutRolePolicy", "iam:PutRolePermissionsBoundary",
      "iam:CreateUser", "iam:PutUserPolicy", "iam:PutUserPermissionsBoundary",
    ]
    resources = [
      "arn:aws:iam::${local.acct}:role/${local.prefix}-*",
      "arn:aws:iam::${local.acct}:user/${local.prefix}-*",
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.boundary.arn]
    }
  }

  statement {
    sid       = "PassRole"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.acct}:role/${local.prefix}-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }

  # CloudFront distributions have generated IDs, so they are scoped by their Stack tag (the stacks'
  # default tags) instead of by name. This covers UntagResource too, so a role can only untag its
  # own stack's distribution.
  statement {
    sid       = "Distribution"
    actions   = ["cloudfront:*"]
    resources = ["arn:aws:cloudfront::${local.acct}:distribution/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Stack"
      values   = [var.stack]
    }
  }

  # CreateDistribution has no resource type, so it matches only "*". A create with tags is also
  # authorized as TagResource on the new distribution.
  statement {
    sid       = "DistributionCreate"
    actions   = ["cloudfront:CreateDistribution"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Stack"
      values   = [var.stack]
    }
  }

  # Tagging sets this stack's Stack tag, on a new distribution or one already tagged for this
  # stack, so a role can't tag the other stack's distribution. Distribution still lets a role
  # retag its own, so a reviewed prod change could hand prod's distribution to staging's role.
  statement {
    sid       = "DistributionTag"
    actions   = ["cloudfront:TagResource"]
    resources = ["arn:aws:cloudfront::${local.acct}:distribution/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Stack"
      values   = [var.stack]
    }
    condition {
      test     = "StringEqualsIfExists"
      variable = "aws:ResourceTag/Stack"
      values   = [var.stack]
    }
  }

  # CreateFunction has no resource type, so it matches only "*" and can't be scoped by name. Every
  # later call on a function stays on the stack's prefix.
  statement {
    sid       = "EdgeFunctionCreate"
    actions   = ["cloudfront:CreateFunction"]
    resources = ["*"]
  }

  statement {
    sid       = "EdgeFunction"
    actions   = ["cloudfront:*"]
    resources = ["arn:aws:cloudfront::${local.acct}:function/${local.prefix}-*"]
  }

  statement {
    sid = "CloudFrontRead"
    actions = [
      "cloudfront:Get*", "cloudfront:List*", "cloudfront:Describe*",
      "wafv2:Get*", "wafv2:List*", "wafv2:Describe*",
    ]
    resources = ["*"]
  }

  statement {
    sid     = "WebAcl"
    actions = ["wafv2:*"]
    resources = [
      "arn:aws:wafv2:us-east-1:${local.acct}:global/webacl/${local.prefix}/*",
    ]
  }

  statement {
    sid       = "Describe"
    actions   = ["logs:DescribeLogGroups", "ssm:DescribeParameters", "dynamodb:ListTables"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "role_arn" {
  value = aws_iam_role.deploy.arn
}

output "boundary_arn" {
  value = aws_iam_policy.boundary.arn
}
