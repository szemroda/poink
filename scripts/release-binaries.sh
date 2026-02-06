#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

echo "Building pdf-brain v${VERSION} binaries for release..."
echo ""

# Build all platforms
./scripts/compile.sh --all

echo ""

# Check if release already exists
if gh release view "${TAG}" &>/dev/null; then
  echo "Release ${TAG} exists. Uploading binaries..."
  gh release upload "${TAG}" \
    dist/pdf-brain-darwin-arm64 \
    dist/pdf-brain-darwin-x64 \
    dist/pdf-brain-linux-x64 \
    dist/pdf-brain-linux-arm64 \
    dist/pdf-brain-windows-x64.exe \
    --clobber
else
  echo "Creating release ${TAG} with binaries..."
  gh release create "${TAG}" \
    dist/pdf-brain-darwin-arm64 \
    dist/pdf-brain-darwin-x64 \
    dist/pdf-brain-linux-x64 \
    dist/pdf-brain-linux-arm64 \
    dist/pdf-brain-windows-x64.exe \
    --title "pdf-brain ${TAG}" \
    --generate-notes
fi

echo ""
echo "Done. https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/${TAG}"
