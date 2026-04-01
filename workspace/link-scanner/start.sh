#!/usr/bin/env bash
set -a
source "$(dirname "$0")/.env"
set +a
exec "$(dirname "$0")/node_modules/.bin/tsx" "$(dirname "$0")/src/index.ts"
