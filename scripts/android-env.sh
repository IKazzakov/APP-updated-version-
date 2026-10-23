#!/usr/bin/env bash
# Source this file to use a local Android toolchain, or supply existing paths.
movement_project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-$movement_project_dir/work/android-env/jdk}"
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$movement_project_dir/work/android-env/sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-$movement_project_dir/work/android-user}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$movement_project_dir/work/gradle}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/36.0.0:$PATH"
if [[ -f "$movement_project_dir/work/android-env/local.env" ]]; then
  source "$movement_project_dir/work/android-env/local.env"
fi
unset movement_project_dir
