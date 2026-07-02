#!/usr/bin/env sh
# Convert every docs/*.md into an A4 PDF next to it.
set -e
cd "$(dirname "$0")/../docs"
for f in *.md; do
  echo "→ $f"
  npx -y md-to-pdf \
    --pdf-options '{"format":"A4","margin":{"top":"18mm","right":"16mm","bottom":"18mm","left":"16mm"},"printBackground":true}' \
    "$f"
done
