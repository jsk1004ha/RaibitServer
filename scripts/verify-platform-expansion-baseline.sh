#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node "$ROOT_DIR/scripts/platform-expansion-baseline.mjs" "$@"
