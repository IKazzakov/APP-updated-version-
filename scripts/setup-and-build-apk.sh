#!/usr/bin/env bash
set -euo pipefail

# Use the existing JDK/SDK instead of modifying /opt or assuming /app/applet.
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
source scripts/android-env.sh
exec node scripts/build-staging-apk.mjs "$@"
