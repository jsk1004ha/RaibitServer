#!/usr/bin/env bash
set -euo pipefail

if [[ "${RAIBITSERVER_PRODUCTION_EVIDENCE:-}" != "1" ]]; then
  printf '%s\n' '{"status":"NOT_RUN","releaseEligible":false,"reason":"production_evidence_not_enabled"}'
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/lib/domain-runner.mjs" "$@"
