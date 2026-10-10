#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/third_party/codex-desktop-zh/macos"

for target in arm64 x86_64; do
  swift build --package-path "$SOURCE" -c release --arch "$target"
  binary="$SOURCE/.build/$target-apple-macosx/release/CodexZhLauncherMac"
  bundle_arch="$target"
  if [[ "$target" == "x86_64" ]]; then bundle_arch=x64; fi
  bundle="$ROOT/vendor/mac/$bundle_arch/Codex 汉化增强工具.app"
  cp "$binary" "$bundle/Contents/MacOS/CodexZhLauncherMac"
  codesign --force --deep --sign - "$bundle"
  codesign --verify --deep --strict "$bundle"
done
