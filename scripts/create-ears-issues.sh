#!/usr/bin/env bash
# Create one GitHub issue per EARS story file under docs/stories/.
#
# Usage: REPO=mknoth197/harness-haircut bash scripts/create-ears-issues.sh
# Requires: gh CLI authed as a user with write access to $REPO.

set -euo pipefail

REPO="${REPO:-mknoth197/harness-haircut}"
STORY_DIR="$(dirname "$0")/../docs/stories"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found." >&2
  exit 127
fi

# The order matters for human readability of issue numbers; sort ensures stability.
# Use a portable while-read loop (mapfile is bash 4+, not on macOS /bin/bash).
FILES=()
while IFS= read -r line; do
  FILES+=("$line")
done < <(find "$STORY_DIR" -maxdepth 1 -name '[0-9][0-9]-*.md' | sort)

for f in "${FILES[@]}"; do
  # Title is the H1 of the file.
  title="$(awk '/^# /{ sub(/^# /, ""); print; exit }' "$f")"
  # Body is everything after the H1.
  body="$(awk 'BEGIN{p=0} /^# /{ if(!p){p=1; next} } p{print}' "$f")"

  echo "Creating: $title"
  gh issue create \
    --repo "$REPO" \
    --title "$title" \
    --body "$body" \
    --label "enhancement"
done

echo "Done. Add cross-reference comments by hand or extend this script."
