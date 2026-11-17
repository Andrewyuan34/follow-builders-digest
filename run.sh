#!/bin/bash
set -euo pipefail
unset NODE_OPTIONS HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$PROJECT_DIR/scripts"
exec /usr/bin/node scheduled-digest.js >> "$PROJECT_DIR/digest.log" 2>&1
