#!/usr/bin/env bash
set -euo pipefail

# Build the primary installed app with its existing signing identity and JDK/SDK.
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
source scripts/android-env.sh
exec node scripts/build-staging-apk.mjs "$@"
