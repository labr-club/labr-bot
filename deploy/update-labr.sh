#!/usr/bin/env bash
# Moves the running Labr bot (~/labr) onto this repo. Run on the machine that
# runs the bot. Leaves ~/claudetaur and ~/telecentaur untouched.
#
#   bash update-labr.sh            # check, back up, update, restart
#   bash update-labr.sh --check    # only compare the running code with this repo
set -euo pipefail

DIR="${LABR_DIR:-$HOME/labr}"
REPO="${LABR_REPO:-https://github.com/labr-club/labr-bot.git}"
PRE_TAG="labr/labr-running"   # branch: the exact code that ran on the Mac mini before this update
MODE="${1:-}"

[ -d "$DIR/.git" ] || { echo "$DIR is not a git checkout, stopping."; exit 1; }
[ -f "$DIR/.env" ] || { echo "No $DIR/.env, stopping."; exit 1; }
cd "$DIR"

git remote get-url labr >/dev/null 2>&1 || git remote add labr "$REPO"
git fetch --quiet labr

# 1. Is what runs here the code this repo was built from? labr-running is a
#    byte-exact snapshot of it, so the expected answer is "none". Any difference
#    means there is a local change this repo does not have.
echo "== Differences between the running code and $PRE_TAG (bot.js, held-actions.js):"
if git diff --quiet "$PRE_TAG" -- bot.js held-actions.js; then
  echo "none"
else
  git diff --stat "$PRE_TAG" -- bot.js held-actions.js
  git diff "$PRE_TAG" -- bot.js held-actions.js > "$HOME/labr-running-vs-repo.diff"
  echo "Full diff saved to $HOME/labr-running-vs-repo.diff"
  echo "Something changed here since the snapshot. Port it into the repo first,"
  echo "or re-run with LABR_ACCEPT_DIFF=1 to go ahead anyway (the backup keeps it)."
  [ "${LABR_ACCEPT_DIFF:-0}" = "1" ] || [ "$MODE" = "--check" ] || exit 1
fi
[ "$MODE" = "--check" ] && exit 0

# 2. Back up everything, including .env and users.db.
BACKUP="$HOME/labr-backup-$(date +%Y%m%d-%H%M%S)"
cp -a "$DIR" "$BACKUP"
echo "== Backup: $BACKUP"

# 3. Switch to the repo's code. Local edits are stashed, not dropped.
git stash push --quiet -m "pre-labr-bot-$(date +%Y%m%d)" || true
# Files that were local-only before and are part of the repo now would block the
# checkout. They are in the backup; set them aside here.
for f in labr-prompt.txt labr.config.cjs LABR.md; do
  if [ -e "$f" ] && ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then mv "$f" "$f.pre-update"; fi
done
git checkout --quiet -B labr labr/main
npm ci --omit=dev --silent

# 4. Use the prompt file from the repo. The old inline SYSTEM_PROMPT stays in
#    .env as a fallback; the file wins.
grep -q '^SYSTEM_PROMPT_FILE=' .env || printf '\nSYSTEM_PROMPT_FILE=labr-prompt.txt\n' >> .env

node --check bot.js
if ! grep -q '^WORLD_ID_CLIENT_ID=.\+' .env; then
  echo "== Note: WORLD_ID_* is not set, so the contributor payout tool is disabled until it is."
fi

# 5. Restart and show the first lines of the log.
pm2 restart labr --update-env
sleep 6
pm2 logs labr --lines 25 --nostream
echo
echo "Look for: 'Prompt: file labr-prompt.txt' and 'Chains: N from Connect'."
echo "To go back: pm2 stop labr && rm -rf $DIR && cp -a $BACKUP $DIR && pm2 restart labr"
