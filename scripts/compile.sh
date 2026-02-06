#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
DEFINE="--define __PDF_BRAIN_VERSION__=\"\\\"${VERSION}\\\"\""
ENTRY="src/cli.ts"
OUTDIR="dist"

# All supported targets
# bun compile docs: https://bun.sh/docs/bundler/executables
TARGETS=(
  "bun-darwin-arm64"
  "bun-darwin-x64"
  "bun-linux-x64"
  "bun-linux-arm64"
  "bun-windows-x64"
)

build_target() {
  local target="$1"
  local suffix="${target#bun-}"  # strip "bun-" prefix -> darwin-arm64, linux-x64, etc.
  local ext=""
  [[ "${suffix}" == windows-* ]] && ext=".exe"
  local outfile="${OUTDIR}/pdf-brain-${suffix}${ext}"

  echo "  ${suffix}..."
  eval bun build --compile --target "${target}" "${ENTRY}" --outfile "${outfile}" ${DEFINE}
  echo "    -> ${outfile} ($(du -sh "${outfile}" | cut -f1 | xargs))"
}

mkdir -p "${OUTDIR}"

if [ "${1:-}" = "--all" ]; then
  echo "Compiling pdf-brain v${VERSION} for all platforms:"
  for target in "${TARGETS[@]}"; do
    build_target "${target}"
  done
  echo ""
  echo "Done. Binaries in ${OUTDIR}/"
  ls -lh "${OUTDIR}"/pdf-brain-*

elif [ -n "${1:-}" ]; then
  # Build specific target, e.g. ./scripts/compile.sh linux-x64
  target="bun-${1}"
  echo "Compiling pdf-brain v${VERSION} for ${1}:"
  build_target "${target}"

else
  # Default: build for current platform
  echo "Compiling pdf-brain v${VERSION} (native):"
  echo "  native..."
  eval bun build --compile "${ENTRY}" --outfile "${OUTDIR}/pdf-brain" ${DEFINE}
  SIZE=$(du -sh "${OUTDIR}/pdf-brain" | cut -f1 | xargs)
  echo "    -> ${OUTDIR}/pdf-brain (${SIZE})"
fi
