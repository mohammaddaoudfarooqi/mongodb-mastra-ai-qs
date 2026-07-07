#!/bin/bash
#
# One-command local bring-up for the MongoDB x Mastra concierge reference app.
#
#   ./scripts/setup.sh            # first run copies .env.example → .env and exits
#   # fill in MONGODB_URI, VOYAGE_API_KEY, LLM creds in .env, then:
#   ./scripts/setup.sh            # brings up the app in Docker, seeds Atlas,
#                                 # launches Mastra Studio, opens the browser
#
# What it starts:
#   • Storefront + API  → http://localhost:8000        (Docker: node .mastra/output)
#   • Mastra Studio     → http://localhost:4111        (mastra dev, on the host)
#   • API docs (Swagger)→ http://localhost:8000/mastra/api  (Mastra's built-in docs)
#
# Data (provision → seed → embed) runs ONCE on the host against your Atlas
# cluster — never inside the image build (Cloud 15-min cap + ephemeral fs).

set -e

APP_URL="http://localhost:8000"
STUDIO_URL="http://localhost:4111"
SWAGGER_URL="http://localhost:8000/mastra/api"

echo "🛍️  MongoDB x Mastra concierge — local setup"
echo "============================================"

# ── 1. .env ──────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "📝 Creating .env from .env.example…"
  cp .env.example .env
  echo "⚠️  Fill in MONGODB_URI, MONGODB_DATABASE, VOYAGE_API_KEY, and your LLM"
  echo "   credentials in .env, then re-run: ./scripts/setup.sh"
  exit 1
fi

# Load .env into this shell (ignore comments/blank lines).
set -a; . ./.env; set +a

if [ -z "$MONGODB_URI" ]; then
  echo "❌ MONGODB_URI is not set in .env — add your Atlas connection string."
  exit 1
fi
if [ -z "$VOYAGE_API_KEY" ]; then
  echo "❌ VOYAGE_API_KEY is not set in .env — add your Voyage key."
  exit 1
fi
echo "✅ .env loaded (Atlas + Voyage configured)."

# ── 2. Data bootstrap against Atlas (idempotent-ish; safe to re-run) ──────────
echo ""
echo "🗄️  Provisioning indexes, seeding data, and embedding assets on Atlas…"
echo "   (this hits your cluster directly and can take a few minutes)"
pnpm install --frozen-lockfile
pnpm provision
pnpm seed
pnpm embed
echo "✅ Atlas provisioned + seeded."

# ── 3. App container (storefront + API) ───────────────────────────────────────
echo ""
echo "🐳 Building and starting the app container (storefront + API on :8000)…"
docker compose up -d --build

# ── 4. Mastra Studio on the host (needs source; not in the prod image) ────────
echo ""
echo "🎛️  Launching Mastra Studio (dev server) on :4111…"
pnpm exec mastra dev > .mastra-studio.log 2>&1 &
STUDIO_PID=$!
echo "   Studio logs → .mastra-studio.log (pid $STUDIO_PID)"

cleanup() {
  echo ""
  echo "🛑 Stopping Mastra Studio (pid $STUDIO_PID)…"
  kill "$STUDIO_PID" 2>/dev/null || true
}
trap cleanup INT TERM

open_browser() {
  local url=$1
  if [[ "$OSTYPE" == "darwin"* ]]; then open "$url" >/dev/null 2>&1 || true
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then xdg-open "$url" >/dev/null 2>&1 || sensible-browser "$url" >/dev/null 2>&1 || echo "   Open $url in your browser"
  elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then start "$url" >/dev/null 2>&1 || true
  else echo "   Open $url in your browser"; fi
}

# ── 5. Wait for readiness, then open the browser ──────────────────────────────
echo ""
echo "🔍 Waiting for services to be ready…"
MAX_ATTEMPTS=40
ATTEMPT=0
ALL_READY=false
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  APP_READY=false; STUDIO_READY=false
  curl -sf "$APP_URL/api/health" >/dev/null 2>&1 && APP_READY=true
  curl -sf "$STUDIO_URL" >/dev/null 2>&1 && STUDIO_READY=true

  if [ "$APP_READY" = true ] && [ "$STUDIO_READY" = true ]; then
    ALL_READY=true
    echo ""
    echo "✅ All services are ready!"
    echo "🚀 Opening the storefront, Mastra Studio, and API docs…"
    open_browser "$APP_URL";     sleep 1
    open_browser "$STUDIO_URL";  sleep 1
    open_browser "$SWAGGER_URL"
    break
  fi
  echo -n "⏳ ["
  [ "$APP_READY" = true ] && echo -n "app ✓" || echo -n "app ✗"
  echo -n " | "
  [ "$STUDIO_READY" = true ] && echo -n "studio ✓" || echo -n "studio ✗"
  echo "] (attempt $((ATTEMPT+1))/$MAX_ATTEMPTS)"
  ATTEMPT=$((ATTEMPT + 1))
  sleep 5
done

if [ "$ALL_READY" = false ]; then
  echo ""
  echo "⚠️  Not all services came up in time. Check:"
  echo "    • App logs:    docker compose logs -f backend"
  echo "    • Studio logs: tail -f .mastra-studio.log"
  echo "    Manual URLs: $APP_URL · $STUDIO_URL · $SWAGGER_URL"
fi

echo ""
echo "🎉 Setup complete."
echo "   Storefront : $APP_URL"
echo "   Studio     : $STUDIO_URL"
echo "   API docs   : $SWAGGER_URL"
echo ""
echo "   Stop the app:    docker compose down"
echo "   Stop Studio:     kill $STUDIO_PID   (or Ctrl-C to stop this script + Studio)"
echo ""
echo "ℹ️  Note: transactional checkout requires a MongoDB Atlas / replica-set"
echo "   cluster (multi-document transactions)."

# Keep the script alive so Studio (a child process) stays up until Ctrl-C.
wait $STUDIO_PID
