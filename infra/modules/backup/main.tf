# A stack's backups (backup ADR): the backup bucket, and the snapshot Lambda that writes a Backup
# Snapshot of the table (a paced Scan, gzipped JSON Lines) and copies new images into the bucket.
# EventBridge runs it each night; the prod deploy job starts it before each release
# (scripts/backup-snapshot.sh). The API reads the bucket through the stack's data policy, to presign
# `backup pull`'s download links. A stale backup alarm emails the household when a UTC day passes
# without a completed nightly snapshot.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name" {
  description = "The function's, role's, log group's and nightly rule's name, for example plateful-staging-backup."
  type        = string
}

variable "bucket" {
  description = "The backup bucket's globally unique name."
  type        = string
}

variable "zip_path" {
  description = "The API's Lambda zip, which holds the recipes.backup handler too."
  type        = string
}

variable "runtime" {
  type = string
}

variable "table_name" {
  type = string
}

variable "table_arn" {
  type = string
}

variable "images_bucket" {
  type = string
}

variable "images_bucket_arn" {
  type = string
}

variable "read_units" {
  description = "The read capacity the Scan paces itself to."
  type        = number
}

variable "permissions_boundary_arn" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 14
}

locals {
  # Days each kind of snapshot is kept: 30 nightly and 12 monthly (backup ADR), and the pre-release
  # ones as long as the nightly. images/ has no rule: image copies are kept for good.
  snapshot_days = {
    nightly       = 30
    "pre-release" = 30
    monthly       = 365
  }
}

module "bucket" {
  source = "../private-bucket"
  name   = var.bucket
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = module.bucket.name

  dynamic "rule" {
    for_each = local.snapshot_days
    content {
      id     = "expire-${rule.key}"
      status = "Enabled"
      filter {
        prefix = "snapshots/${rule.key}/"
      }
      expiration {
        days = rule.value
      }
    }
  }

  # A snapshot cut off mid-upload would otherwise leave billed parts behind.
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = var.name
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = var.log_retention_days
}

# Scan the table, read the images, and read and write the backup bucket. Nothing else: no deletes,
# so a bad run can't remove an older snapshot (the lifecycle rules expire them).
data "aws_iam_policy_document" "this" {
  statement {
    sid       = "Table"
    actions   = ["dynamodb:Scan"]
    resources = [var.table_arn]
  }

  statement {
    sid       = "ImagesList"
    actions   = ["s3:ListBucket"]
    resources = [var.images_bucket_arn]
  }

  statement {
    sid       = "ImagesRead"
    actions   = ["s3:GetObject"]
    resources = ["${var.images_bucket_arn}/*"]
  }

  statement {
    sid       = "BackupList"
    actions   = ["s3:ListBucket"]
    resources = [module.bucket.arn]
  }

  statement {
    sid       = "BackupObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${module.bucket.arn}/*"]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
}

resource "aws_iam_role_policy" "this" {
  name   = "backup"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.this.json
}

resource "aws_lambda_function" "this" {
  function_name    = var.name
  role             = aws_iam_role.this.arn
  runtime          = var.runtime
  architectures    = ["arm64"]
  handler          = "recipes.backup.handler"
  filename         = var.zip_path
  source_code_hash = filebase64sha256(var.zip_path)
  # A paced Scan of prod is a few minutes; Lambda's limit is 15. Nightly at 512 MB, a full 15
  # minutes is 450 GB-s, far inside the free 400,000 GB-s a month. The snapshot is written to /tmp
  # first, and the default 512 MB of it holds a few-MB gzip with room to spare.
  memory_size = 512
  timeout     = 900

  environment {
    variables = {
      TABLE_NAME          = var.table_name
      IMAGES_BUCKET       = var.images_bucket
      BACKUP_BUCKET       = var.bucket
      SNAPSHOT_READ_UNITS = tostring(var.read_units)
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.this.name
  }

  depends_on = [aws_iam_role_policy.this]
}

# No retries of an asynchronous invocation (the nightly rule's and `make backup-snapshot`'s): a
# failed snapshot is one paced Scan, not three, and its error is in the function's logs.
resource "aws_lambda_function_event_invoke_config" "this" {
  function_name          = aws_lambda_function.this.function_name
  maximum_retry_attempts = 0
}

# An EventBridge rule, not EventBridge Scheduler, so no role is needed to invoke the function.
# 10:00 UTC is the middle of the household's night.
resource "aws_cloudwatch_event_rule" "nightly" {
  name                = var.name
  description         = "The nightly Backup Snapshot."
  schedule_expression = "cron(0 10 * * ? *)"
}

resource "aws_cloudwatch_event_target" "nightly" {
  rule  = aws_cloudwatch_event_rule.nightly.name
  arn   = aws_lambda_function.this.arn
  input = jsonencode({ kind = "nightly" })
}

resource "aws_lambda_permission" "nightly" {
  statement_id  = "EventsInvoke-nightly"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.nightly.arn
}

# The stale backup alarm's topic. The household's email addresses are subscribed by hand
# (scripts/aws-setup.sh), as for the spend alarm: an email subscription stays pending until it's
# confirmed, and the repo is public. Not the spend alarm's topic: that one trips the kill switches.
# SNS's default topic policy lets the account's own alarms publish.
resource "aws_sns_topic" "alarm" {
  name = var.name
}

# The handler counts each completed nightly snapshot (recipes.backup.NIGHTLY_METRIC). The wall clock
# window evaluates exactly the last whole UTC day, and missing data is breaching, so a day with no
# count alarms whether the snapshot failed or the schedule never fired: the household hears by
# 00:00 UTC after a 10:00 UTC nightly fails, about 14 hours later. A sliding window would instead
# borrow an older datapoint to fill the gap and stay OK for days. The warm-up keeps a new alarm
# quiet until a whole day with a nightly in it has passed. OK actions report the recovery, and the
# first evaluation after the warm-up, which confirms the alarm works.
resource "aws_cloudwatch_metric_alarm" "stale" {
  alarm_name          = var.name
  alarm_description   = "A whole UTC day passed without a completed nightly Backup Snapshot from ${var.name}: check its logs."
  namespace           = "Plateful"
  metric_name         = "NightlyBackupSnapshots"
  dimensions          = { FunctionName = aws_lambda_function.this.function_name }
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarm.arn]
  ok_actions          = [aws_sns_topic.alarm.arn]

  evaluation_window {
    wall_clock_window {}
  }

  warm_up_configuration {
    warm_up_period_duration_in_minutes              = 2880
    only_start_evaluating_after_warm_up_period_ends = true
  }
}

output "function_name" {
  value = aws_lambda_function.this.function_name
}

output "bucket" {
  value = module.bucket.name
}

output "wiring" {
  description = "The function's name and environment and its policy's grants by statement, for infra/tests."
  value = {
    function_name = aws_lambda_function.this.function_name
    environment   = aws_lambda_function.this.environment[0].variables
    # Read from the policy document's statements, not the variables, since infra/tests mocks the JSON.
    grants = { for s in data.aws_iam_policy_document.this.statement : s.sid => {
      actions   = toset(s.actions)
      resources = toset(s.resources)
    } }
  }
}
