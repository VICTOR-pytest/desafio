#!/bin/sh
set -eu

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
BASE_URL="http://sqs.${REGION}.localhost.localstack.cloud:4566/000000000000"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"
VISIBILITY_TIMEOUT="${SQS_VISIBILITY_TIMEOUT_SECONDS:-30}"

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true >/dev/null

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "${BASE_URL}/wager-transactions-dlq.fifo" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

REDRIVE="{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":${MAX_RECEIVE_COUNT}}"

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "$(printf '{"FifoQueue":"true","VisibilityTimeout":"%s","RedrivePolicy":%s}' \
    "${VISIBILITY_TIMEOUT}" "$(printf '%s' "${REDRIVE}" | sed 's/"/\\"/g; s/^/"/; s/$/"/')")" >/dev/null

awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true >/dev/null
