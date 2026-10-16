#!/usr/bin/env bash
#
# Idempotent repository initialisation.
#
# WHY THIS SCRIPT EXISTS rather than a one-off `git init`:
# this workspace excludes `.git/config` from its saved snapshot (it can hold credentials),
# so the local repository configuration can be missing even though the rest of `.git`
# survived. Running this script restores a usable repository — it does not delete history.
#
# Safe to run at any time. It will not commit, and it will not touch a foreign `.git`.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d .git ]; then
  echo "Initialising a new repository..."
  git init -q
fi

# Restore settings if `.git/config` did not survive. `git config` writes the file back.
git config core.repositoryformatversion 0
git config core.filemode true
git config core.bare false
git config core.logallrefupdates true
git config core.autocrlf input      # Windows contributors keep LF in the repo
git config user.name  "${GIT_AUTHOR_NAME:-Campus Dev}"
git config user.email "${GIT_AUTHOR_EMAIL:-dev@campus.local}"

echo "Repository ready at $(pwd)"
git status --short | head -20
echo "---"
git log --oneline 2>/dev/null | head -5 || echo "(no commits yet)"
