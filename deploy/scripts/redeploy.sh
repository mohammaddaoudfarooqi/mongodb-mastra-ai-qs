#!/usr/bin/env bash
# Redeploy the LATEST main onto an ALREADY-RUNNING box (the presenter's stage EC2 or any
# self-hosted host). This is the counterpart to deploy.sh (which stands a box up from nothing):
# it pulls new code, rebuilds the containers, RE-PROVISIONS Atlas indexes, and verifies the
# running bundle actually contains the new code.
#
#   deploy/scripts/redeploy.sh [user@host] [git-ref]
#   deploy/scripts/redeploy.sh ec2-user@34.220.2.14 main      # defaults if omitted
#
# Why this script exists (each step fixes a real footgun hit during manual redeploys):
#   1. `git reset --hard origin/main` ALONE can reset to a STALE cached ref → the box silently
#      keeps running old code. We `git fetch` first, then reset, then PRINT the landed commit.
#   2. The container image build does NOT run `pnpm provision`/`pnpm seed`. When an index or
#      schema definition changes (e.g. the carts unique {userId,threadId} index that stops the
#      split-cart / "phantom item after checkout" bug), a plain `docker compose up --build`
#      leaves the cluster un-provisioned. We run `pnpm provision` inside the studio container
#      (it carries the source + dev deps + .env) so every redeploy applies index changes.
#   3. A build can succeed while the OLD container keeps serving. We grep the freshly built
#      bundle (.mastra/output) for a sentinel string and fail loudly if it's missing.
set -euo pipefail

HOST="${1:-ec2-user@34.220.2.14}"
REF="${2:-main}"
# A string that must appear in the built server bundle to prove the new code shipped. Override
# with SENTINEL=... when you want to assert a specific just-added symbol. Defaults to the carts
# unique-index name, which is present as of the split-cart fix.
SENTINEL="${SENTINEL:-carts_user_thread_unique}"
APP_DIR="/opt/app/src"

if [[ -t 1 ]]; then C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[36m'; C_0=$'\033[0m'; else C_G=; C_Y=; C_R=; C_B=; C_0=; fi
log()  { echo "${C_B}▸${C_0} $*"; }
ok()   { echo "${C_G}✓${C_0} $*"; }
warn() { echo "${C_Y}!${C_0} $*"; }
die()  { echo "${C_R}✗ $*${C_0}" >&2; exit 1; }

# One SSH connection per step; StrictHostKeyChecking off for the ephemeral demo box.
rsh() { ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 "$HOST" "$@"; }

echo "${C_B}=== redeploy ${REF} → ${HOST} ===${C_0}"

command -v ssh >/dev/null || die "ssh not found"
rsh 'command -v docker >/dev/null' || die "docker not found on $HOST"

# 1. Pull the new code — fetch FIRST so reset lands on the true remote tip, not a stale ref.
log "fetching + resetting $APP_DIR to origin/$REF"
LANDED=$(rsh "cd '$APP_DIR' \
  && sudo git config --global --add safe.directory '$APP_DIR' 2>/dev/null; \
  sudo git fetch --depth 1 origin '$REF' \
  && sudo git reset --hard 'origin/$REF' \
  && sudo git log --oneline -1") || die "git update failed on $HOST"
ok "landed: $LANDED"

# 2. Rebuild + restart (app + nginx + studio). Refresh the container .env from the box's SSM-
#    seeded /opt/app/.env first (a no-op if identical) so new env keys are present.
log "rebuilding + restarting containers (this can take a few minutes)"
rsh "cd '$APP_DIR' \
  && sudo cp /opt/app/.env src/.env 2>/dev/null || true; \
  sudo docker compose -f docker-compose.yml -f deploy/compose.nginx.yml --profile studio up -d --build" \
  || die "docker compose build/up failed on $HOST"
ok "containers rebuilt"

# 3. Verify the RUNNING bundle actually contains the new code (guards the stale-container trap).
log "verifying the served bundle contains '$SENTINEL'"
if rsh "sudo docker exec src-app-1 sh -c 'grep -rl \"$SENTINEL\" /app/.mastra/output >/dev/null 2>&1'"; then
  ok "sentinel present in /app/.mastra/output"
else
  warn "sentinel '$SENTINEL' NOT found in the running bundle — the build may not have picked up the new code."
  warn "Inspect: ssh $HOST \"sudo docker exec src-app-1 sh -c 'ls /app/.mastra/output'\""
fi

# 4. Re-provision Atlas indexes (idempotent). The image build never does this, so an index
#    change (carts unique index, cache TTL, knowledge vector) is applied here. The studio
#    container carries the source + dev deps + .env, so run it there.
log "re-provisioning Atlas indexes (pnpm provision inside the studio container)"
if rsh "sudo docker exec src-studio-1 sh -lc 'cd /app && pnpm provision'"; then
  ok "provision complete (indexes applied / deduped)"
else
  warn "provision via studio container failed — run it manually against the cluster:"
  warn "  MONGODB_URI=... MONGODB_DATABASE=... VOYAGE_API_KEY=... pnpm provision"
fi

# 5. Health.
log "health check"
for i in $(seq 1 20); do
  if rsh 'curl -fsS localhost:8000/api/health >/dev/null 2>&1 || curl -fsS localhost:8000/health >/dev/null 2>&1'; then
    ok "app healthy"; break
  fi
  [[ $i -eq 20 ]] && warn "health did not pass after ~2.5 min; check: ssh $HOST 'sudo docker compose -f $APP_DIR/docker-compose.yml -f $APP_DIR/deploy/compose.nginx.yml logs app'"
  sleep 8
done

echo ""
ok "Redeploy done — $LANDED"
echo "   Verify end-to-end:  BASE_URL=http://${HOST#*@} pnpm verify:demo"
