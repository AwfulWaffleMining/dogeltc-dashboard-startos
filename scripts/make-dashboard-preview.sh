#!/bin/sh
# Builds the standalone web preview of the dashboard: the packaged page serves
# its fonts from disk and never fakes data, while the preview has neither a
# server nor local font files.
set -eu
src="${1:-dashboard/index.html}"
out="${2:-quai-dashboard-preview.html}"
sed -e 's|<meta name="dash-mode" content="live">|<meta name="dash-mode" content="auto">|' \
    -e 's|^@font-face.*$||' \
    -e 's|<style>|<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Bai+Jamjuree:wght@400;500;600;700\&family=JetBrains+Mono:wght@400;500\&family=Michroma\&display=swap" rel="stylesheet"><style>|' \
    "$src" > "$out"
echo "wrote $out"
