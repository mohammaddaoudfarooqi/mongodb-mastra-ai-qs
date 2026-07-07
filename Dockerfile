# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Backend image: builds the React SPA + the Mastra server into one deployable,
# then runs `node .mastra/output/index.mjs` — the SAME artifact Mastra Cloud
# runs (`mastra build` → `.mastra/output`). The server serves both the `/api/*`
# routes and the storefront SPA (frontend/dist) on one origin.
#
# Ingestion (seed/embed/provision) is intentionally NOT run here: it stays a
# one-off job against Atlas, so the image build respects the Cloud 15-min build
# cap and the ephemeral filesystem (REQ-E-011).
# ─────────────────────────────────────────────────────────────────────────────

# ---- Stage 1: build (frontend dist + mastra output) ----
FROM node:22-alpine AS build
WORKDIR /app

# pnpm via corepack (repo uses pnpm@11).
RUN corepack enable

# Backend deps (cached on lockfile change).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Frontend deps + build → frontend/dist (served by the backend for the SPA).
COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && npm install --legacy-peer-deps

# Source, then build both artifacts.
COPY . .
RUN cd frontend && npm run build
RUN pnpm build            # mastra build → .mastra/output (self-contained, own node_modules)

# ---- Stage 2 (optional): Mastra Studio (dev UI on :4111) ----
# Studio needs the TypeScript source + dev deps, so it runs from the build stage
# rather than the lean runtime image. It is opt-in: only the `studio` compose
# profile builds/starts it (`docker compose --profile studio up`). Not a
# production artifact — use it for demos, tracing, and the visual workflow runner.
FROM build AS studio
WORKDIR /app
ENV NODE_ENV=development
EXPOSE 4111
CMD ["pnpm", "exec", "mastra", "dev", "--port", "4111"]

# ---- Stage 3: runtime (minimal, non-root) ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The built Mastra server (self-contained) + the built SPA it serves.
COPY --from=build /app/.mastra/output ./.mastra/output
COPY --from=build /app/frontend/dist ./frontend/dist

# Run as a non-root user.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

ENV PORT=8000
EXPOSE 8000

# Liveness: the server's public /api/health (see REQ-E-005).
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", ".mastra/output/index.mjs"]
