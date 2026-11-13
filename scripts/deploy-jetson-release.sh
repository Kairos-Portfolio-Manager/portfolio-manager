#!/usr/bin/env bash
# One-command Jetson deploy for a reviewed mandate-v3 release, with the stop checks built in.
#
#   cd ~/portfolio-manager && bash /path/to/deploy-jetson-release.sh <release-sha>   (run from inside the checkout)
#
# <release-sha> is the mandate-v3 head Sam C approved (short or full). The script:
#   1. refuses a dirty tree, an unexpected origin/mandate-v3 head, or a Jetson older than 40ee20b
#   2. shows exactly what will ship and asks for a y to continue (the green light)
#   3. pulls, runs npm test (rolls the checkout back on failure: nothing restarted)
#   4. db:migrate, signed deploy:restart, pm2 restart pitch-lab, health, sysloop, Pitch Lab snapshot
#   5. prints the report to send back to Sam C
# Release notes: docs/releases/2026-11-14-weekly-mandate-review.md
set -euo pipefail

BRANCH=mandate-v3
FLOOR=40ee20b   # the oldest Jetson HEAD this release was written against
EXPECTED="${1:-}"
# Deploy the checkout you are standing in (the script may be run from /tmp).
REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "STOP: run this from inside ~/portfolio-manager."; exit 1; }
cd "$REPO"
[ -f scripts/restart-with-pm2-deploy-marker.js ] || { echo "STOP: $REPO is not the portfolio-manager checkout."; exit 1; }
LOG="${TMPDIR:-/tmp}/pm-deploy-test.log"

die() { echo; echo "STOP: $*"; echo "Nothing was restarted. Send this output to Sam C."; exit 1; }
step() { echo; echo "── $* ──"; }

[ -n "$EXPECTED" ] || die "usage: bash scripts/deploy-jetson-release.sh <release-sha from Sam C>"

step "Preflight"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "the working tree has local changes (git status)."
ROLLBACK=$(git rev-parse HEAD)
echo "Current HEAD (rollback target): $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)"
echo "$ROLLBACK" > "${TMPDIR:-/tmp}/pm-deploy-rollback-sha"
git fetch -q origin
TARGET=$(git rev-parse "origin/$BRANCH")
case "$TARGET" in "$EXPECTED"*) ;; *) die "origin/$BRANCH is $(git rev-parse --short "$TARGET"), not the release SHA $EXPECTED. Ask Sam C which SHA to deploy." ;; esac
git merge-base --is-ancestor "$FLOOR" HEAD || die "this Jetson is older than $FLOOR, so deploying would also ship older, unreviewed releases."
git merge-base --is-ancestor HEAD "$TARGET" || die "HEAD is not an ancestor of origin/$BRANCH (diverged checkout)."

step "What ships (first-parent commits HEAD..origin/$BRANCH)"
git log --oneline --first-parent "HEAD..$TARGET"
echo
read -r -p "Deploy $(git rev-parse --short "$TARGET") to this Jetson? [y/N] " ok
[ "$ok" = "y" ] || [ "$ok" = "Y" ] || die "not confirmed."

step "Pull"
git switch -q "$BRANCH"
git pull -q --ff-only origin "$BRANCH"
[ "$(git rev-parse HEAD)" = "$TARGET" ] || die "HEAD after pull is not $TARGET."

step "npm test (several minutes; the pitch-lab-mandate-review files are quiet for a while)"
if ! npm test 2>&1 | tee "$LOG" | grep -E "^# (tests|pass|fail|cancelled)"; then :; fi
if ! grep -q "^# fail 0" "$LOG" || ! grep -q "^# cancelled 0" "$LOG"; then
  grep -E "^not ok" "$LOG" | head -20 || true
  git switch -q --detach "$ROLLBACK"
  die "tests failed; checkout rolled back to $(git rev-parse --short "$ROLLBACK"). Full log: $LOG"
fi

step "Migrate + restart"
npm run -s db:migrate
npm run -s deploy:restart || { echo "deploy:restart failed. Roll back: git switch --detach $ROLLBACK && npm run deploy:restart && pm2 restart pitch-lab"; exit 1; }
pm2 restart pitch-lab >/dev/null && echo "pitch-lab restarted"

step "Health"
sleep 5
HEALTH=$(curl -sS -m 10 http://localhost:3200/health || true)
echo "$HEALTH" | head -c 600; echo
echo "$HEALTH" | grep -q '"ok":true' || echo "WARNING: /health is not ok. Check before walking away."
npm run -s sysloop:check || echo "WARNING: sysloop:check reported problems (see above)."

step "Pitch Lab"
pm2 logs pitch-lab --lines 5 --nostream 2>/dev/null | tail -5 || true
node -e 'import("./lib/pitch-lab/schedule.js").then(m => console.log("next Mandate Review:", m.nextMandateReviewAt()))'
node jobs/pitch-lab-daily.js snapshot | tail -4 || echo "WARNING: snapshot republish failed (the site updates after Monday's run instead)."

step "Report for Sam C"
echo "Deployed $(git rev-parse --short HEAD) (was $(git rev-parse --short "$ROLLBACK"))"
grep -E "^# (tests|pass|fail)" "$LOG"
pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s))if(["portfolio-manager","pitch-lab"].includes(p.name))console.log(p.name,p.pm2_env.status,"restarts="+p.pm2_env.restart_time)})' || true
echo "Rollback if needed: git switch --detach $ROLLBACK && npm run deploy:restart && pm2 restart pitch-lab"
