#!/usr/bin/env bash
set -e

SDK_DIR="/opt/android-sdk"
mkdir -p "$SDK_DIR/cmdline-tools"

if [ ! -d "$SDK_DIR/cmdline-tools/latest" ]; then
  echo "Downloading Android Command Line Tools..."
  curl -sS -o /tmp/cmdline-tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  unzip -q /tmp/cmdline-tools.zip -d "$SDK_DIR/cmdline-tools"
  mv "$SDK_DIR/cmdline-tools/cmdline-tools" "$SDK_DIR/cmdline-tools/latest"
  rm /tmp/cmdline-tools.zip
fi

export ANDROID_HOME="$SDK_DIR"
export PATH="$SDK_DIR/cmdline-tools/latest/bin:$SDK_DIR/platform-tools:$PATH"

echo "Accepting licenses and installing Android SDK platform 34 and build-tools 34.0.0..."
yes | sdkmanager --licenses > /dev/null 2>&1 || true
sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools" > /dev/null

echo "sdk.dir=$SDK_DIR" > /app/applet/android/local.properties

echo "Building web client and syncing Capacitor..."
npm run build
npx cap sync android

echo "Building Android debug APK with Gradle..."
cd /app/applet/android
./gradlew assembleDebug

echo "Copying APK to public distribution path..."
mkdir -p /app/applet/public
mkdir -p /app/applet/dist/client
cp /app/applet/android/app/build/outputs/apk/debug/app-debug.apk /app/applet/public/app-debug.apk
cp /app/applet/android/app/build/outputs/apk/debug/app-debug.apk /app/applet/dist/client/app-debug.apk

echo "SUCCESS! APK is ready at public/app-debug.apk"
