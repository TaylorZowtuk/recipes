# The account's $1-a-month spending guard (hosting ADR): an account-wide budget on actual cost and a
# billing alarm on EstimatedCharges, both sending to one SNS topic that only the account, Budgets
# and CloudWatch may publish to, and each stack's kill-switch function subscribed to it.

# A real but unauthenticated provider: aws_iam_policy_document renders locally, so the test checks
# the topic policy SNS would get, and the overridden resources make no calls.
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

variables {
  account_id = "123456789012"
  kill_switch_arns = {
    prod    = "arn:aws:lambda:us-west-2:123456789012:function:plateful-prod-kill-switch"
    staging = "arn:aws:lambda:us-west-2:123456789012:function:plateful-staging-kill-switch"
  }
}

run "spend_alarm" {
  command = apply # every resource is overridden, so nothing reaches AWS

  module {
    source = "../modules/spend-alarm"
  }

  override_resource {
    target = aws_sns_topic.this
    values = { arn = "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm" }
  }
  override_resource {
    target = aws_sns_topic_policy.this
  }
  override_resource {
    target = aws_budgets_budget.this
  }
  override_resource {
    target = aws_cloudwatch_metric_alarm.this
  }
  override_resource {
    target = aws_sns_topic_subscription.kill_switch
  }

  assert {
    condition     = aws_sns_topic.this.name == "plateful-spend-alarm" && output.topic_arn == "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm"
    error_message = "The account's spend alarm topic is plateful-spend-alarm, outside every stack's prefix."
  }
  assert {
    condition = (
      aws_budgets_budget.this.budget_type == "COST" &&
      aws_budgets_budget.this.time_unit == "MONTHLY" &&
      tonumber(aws_budgets_budget.this.limit_amount) == 1 &&
      aws_budgets_budget.this.limit_unit == "USD" &&
      length(aws_budgets_budget.this.cost_filter) == 0
    )
    error_message = "The budget is $1 a month of cost, for the whole account."
  }
  assert {
    condition = (
      length(aws_budgets_budget.this.notification) == 1 &&
      one(aws_budgets_budget.this.notification).notification_type == "ACTUAL" &&
      one(aws_budgets_budget.this.notification).comparison_operator == "GREATER_THAN" &&
      one(aws_budgets_budget.this.notification).threshold == 100 &&
      one(aws_budgets_budget.this.notification).threshold_type == "PERCENTAGE" &&
      one(aws_budgets_budget.this.notification).subscriber_sns_topic_arns == toset(["arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm"])
    )
    error_message = "The budget notifies the topic once actual cost passes 100% of the limit."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.this.namespace == "AWS/Billing" &&
      aws_cloudwatch_metric_alarm.this.metric_name == "EstimatedCharges" &&
      aws_cloudwatch_metric_alarm.this.dimensions == tomap({ Currency = "USD" }) &&
      aws_cloudwatch_metric_alarm.this.statistic == "Maximum" &&
      aws_cloudwatch_metric_alarm.this.period == 21600 &&
      aws_cloudwatch_metric_alarm.this.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.this.threshold == 1 &&
      aws_cloudwatch_metric_alarm.this.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.this.treat_missing_data == "ignore"
    )
    error_message = "The alarm fires when the account's estimated charges pass $1, and a gap in datapoints keeps its state."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.this.alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm"])
    error_message = "The alarm sends to the topic."
  }
  assert {
    condition = (
      { for k, s in aws_sns_topic_subscription.kill_switch : k => s.endpoint } == {
        prod    = "arn:aws:lambda:us-west-2:123456789012:function:plateful-prod-kill-switch"
        staging = "arn:aws:lambda:us-west-2:123456789012:function:plateful-staging-kill-switch"
      } &&
      alltrue([for s in aws_sns_topic_subscription.kill_switch :
      s.protocol == "lambda" && s.topic_arn == "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm"])
    )
    error_message = "Each stack's kill-switch function, and only those, is subscribed to the topic as a Lambda."
  }
  assert {
    condition = (
      toset([for s in jsondecode(data.aws_iam_policy_document.topic.json).Statement : s.Principal.Service
      if can(s.Principal.Service)]) == toset(["budgets.amazonaws.com", "cloudwatch.amazonaws.com"]) &&
      alltrue([for s in jsondecode(data.aws_iam_policy_document.topic.json).Statement :
        flatten([s.Action]) == ["sns:Publish"] && s.Condition == { StringEquals = { "aws:SourceAccount" = "123456789012" } }
      if can(s.Principal.Service)])
    )
    error_message = "Budgets and CloudWatch may publish to the topic, only on this account's behalf."
  }
  assert {
    condition = toset(flatten([for s in jsondecode(data.aws_iam_policy_document.topic.json).Statement : [
      for p in flatten([s.Principal.AWS]) : p] if can(s.Principal.AWS)
    ])) == toset(["arn:aws:iam::123456789012:root"])
    error_message = "Apart from the two services, only the account itself is a principal on the topic."
  }
}
