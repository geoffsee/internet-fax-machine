#!/usr/bin/env sh
set -e

# Load secrets from .env.secrets
set -a
. ./.env.secrets
set +a

# Push secrets to Cloudflare
printf "%s" "$BASIC_AUTH_USER" | wrangler secret put BASIC_AUTH_USER
printf "%s" "$BASIC_AUTH_PASS" | wrangler secret put BASIC_AUTH_PASS

echo "Secrets uploaded successfully, re-deploying worker..."

# Deploy the worker
wrangler deploy