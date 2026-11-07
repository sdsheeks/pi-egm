#!/usr/bin/env bash
# Vendor the upstream Elephant-Goldfish Model plugin into ./egm, verbatim.
#
# Usage:
#   scripts/sync-upstream.sh              # clone upstream main, copy, record SHA
#   scripts/sync-upstream.sh v0.1.1       # clone a tag/branch/commit
#   SRC=../elephant-goldfish-model scripts/sync-upstream.sh   # use a local clone
#
# Upstream files are copied unchanged (Apache-2.0, see NOTICE). The pi adapter
# lives outside ./egm so upstream text stays unmodified and easy to re-sync.
set -euo pipefail

REPO_URL="https://github.com/google/elephant-goldfish-model"
REF="${1:-main}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/egm"
TMP=""

cleanup() { if [[ -n "$TMP" && -d "$TMP" ]]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT

if [[ -n "${SRC:-}" ]]; then
  SRC="$(cd "$SRC" && pwd)"
  echo "Using local checkout: $SRC"
  COMMIT="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)"
  SRC_TREE="$SRC"
else
  TMP="$(mktemp -d)"
  echo "Cloning $REPO_URL ($REF)..."
  git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$TMP/upstream"
  COMMIT="$(git -C "$TMP/upstream" rev-parse HEAD)"
  SRC_TREE="$TMP/upstream"
fi

echo "Vendoring from commit $COMMIT"

rm -rf "$DEST"
mkdir -p "$DEST"

# The runtime bundle the skills read at run time: skills/, agents/, resources/.
cp -R "$SRC_TREE/skills" "$DEST/skills"
cp -R "$SRC_TREE/agents" "$DEST/agents"
cp -R "$SRC_TREE/resources" "$DEST/resources"

# docs/ is referenced from skill text as ../../docs/<name>.md. Markdown only.
mkdir -p "$DEST/docs"
find "$SRC_TREE/docs" -maxdepth 1 -name '*.md' -exec cp {} "$DEST/docs/" \;

cp "$SRC_TREE/LICENSE" "$DEST/LICENSE"

cat > "$DEST/UPSTREAM.json" <<EOF
{
  "repository": "$REPO_URL",
  "ref": "$REF",
  "commit": "$COMMIT",
  "syncedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "note": "Files under egm/ are unmodified copies of the upstream plugin. Do not edit them here; run scripts/sync-upstream.sh instead."
}
EOF

echo "Synced into $DEST"
find "$DEST" -type f | wc -l | xargs echo "Files:"
