#!/usr/bin/env bash
# Render the README demo GIF from the committed VHS tape.
# Usage: bash scripts/record-demo.sh
set -e

if command -v vhs >/dev/null 2>&1; then
  vhs demo/regressionledger.tape
  echo "✓ Wrote demo/regressionledger.gif — commit it and uncomment the image in README.md"
else
  echo "VHS not found. Install it: https://github.com/charmbracelet/vhs"
  echo
  echo "Asciinema fallback:"
  echo "  asciinema rec --command 'node demo/simulate.js' demo/regressionledger.cast"
  exit 1
fi
