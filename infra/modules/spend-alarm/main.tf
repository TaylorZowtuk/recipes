# The account's $1-a-month spending guard (hosting ADR): an account-wide AWS Budget on actual cost
# and a CloudWatch alarm on EstimatedCharges, both sending to one SNS topic. Billing metrics exist
# only in us-east-1, so the caller passes a us-east-1 provider. Each stack subscribes its own
# kill-switch function to the topic; the household's email addresses are subscribed by hand (see
# scripts/aws-setup.sh), because an email subscription stays pending until it is confirmed and
# the repo is public.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "account_id" {
  type = string
}

locals {
  limit_usd = 1
}

# Outside every stack's prefix, so no deploy role's own-topic grant reaches it.
resource "aws_sns_topic" "this" {
  name = "plateful-spend-alarm"
}

data "aws_iam_policy_document" "topic" {
  # The account owner's rights from SNS's default topic policy.
  statement {
    sid = "Owner"
    actions = [
      "sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:AddPermission", "sns:RemovePermission",
      "sns:DeleteTopic", "sns:Subscribe", "sns:ListSubscriptionsByTopic", "sns:Publish",
    ]
    resources = [aws_sns_topic.this.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }

  statement {
    sid       = "Budgets"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.this.arn]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }

  statement {
    sid       = "BillingAlarm"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.this.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "this" {
  arn    = aws_sns_topic.this.arn
  policy = data.aws_iam_policy_document.topic.json
}

# Actual cost, not forecast: a forecast would fire on a month's first few cents of S3 requests.
resource "aws_budgets_budget" "this" {
  name         = "plateful-spend-alarm"
  account_id   = var.account_id
  budget_type  = "COST"
  limit_amount = tostring(local.limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    notification_type         = "ACTUAL"
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    subscriber_sns_topic_arns = [aws_sns_topic.this.arn]
  }
}

# The month-to-date bill, which AWS publishes every few hours, so one 6-hour period is enough.
resource "aws_cloudwatch_metric_alarm" "this" {
  alarm_name          = "plateful-spend-alarm"
  alarm_description   = "The account's estimated charges this month are over ${local.limit_usd} USD."
  namespace           = "AWS/Billing"
  metric_name         = "EstimatedCharges"
  dimensions          = { Currency = "USD" }
  statistic           = "Maximum"
  period              = 21600
  evaluation_periods  = 1
  threshold           = local.limit_usd
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.this.arn]
}

output "topic_arn" {
  value = aws_sns_topic.this.arn
}
