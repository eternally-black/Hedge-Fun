#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bash "$ROOT/scripts/test-deploy-audit.sh"
bash "$ROOT/scripts/test-backup-pull.sh"
bash "$ROOT/scripts/test-db-helper.sh"
echo "test-ops-audit: PASS"
