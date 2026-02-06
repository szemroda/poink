#!/usr/bin/env bash
set -euo pipefail

REPO="joelhooks/pdf-brain"
BINARY="pdf-brain"
INSTALL_DIR="${PDF_BRAIN_INSTALL_DIR:-/usr/local/bin}"

# Detect platform
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "${OS}" in
  darwin) PLATFORM="darwin" ;;
  linux)  PLATFORM="linux" ;;
  mingw*|msys*|cygwin*) PLATFORM="windows" ;;
  *) echo "Unsupported OS: ${OS}" >&2; exit 1 ;;
esac

case "${ARCH}" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;;
esac

SUFFIX="${PLATFORM}-${ARCH}"
EXT=""
[ "${PLATFORM}" = "windows" ] && EXT=".exe"
ASSET="${BINARY}-${SUFFIX}${EXT}"

# Get latest release tag (or use env override)
if [ -n "${PDF_BRAIN_VERSION:-}" ]; then
  TAG="v${PDF_BRAIN_VERSION}"
else
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
fi

if [ -z "${TAG}" ]; then
  echo "Failed to determine latest version." >&2
  echo "Set PDF_BRAIN_VERSION=x.y.z to install a specific version." >&2
  exit 1
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

echo "Installing pdf-brain ${TAG} (${SUFFIX})..."
echo "  ${URL}"
echo ""

# Download to temp file
TMP=$(mktemp)
trap 'rm -f "${TMP}"' EXIT

HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "${TMP}" "${URL}" 2>/dev/null || true)

if [ "${HTTP_CODE}" != "200" ] || [ ! -s "${TMP}" ]; then
  echo "Download failed (HTTP ${HTTP_CODE})." >&2
  echo "" >&2
  echo "Available assets for ${TAG}:" >&2
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" \
    | grep '"name"' | grep 'pdf-brain' | cut -d'"' -f4 | sed 's/^/  /' >&2 2>/dev/null || true
  echo "" >&2
  echo "Your platform: ${SUFFIX}" >&2
  exit 1
fi

# Install
chmod +x "${TMP}"

if [ -w "${INSTALL_DIR}" ]; then
  mv "${TMP}" "${INSTALL_DIR}/${BINARY}"
else
  echo "  Need sudo to write to ${INSTALL_DIR}"
  sudo mv "${TMP}" "${INSTALL_DIR}/${BINARY}"
fi

echo "Installed ${BINARY} to ${INSTALL_DIR}/${BINARY}"
echo ""
"${INSTALL_DIR}/${BINARY}" --version 2>/dev/null || true
