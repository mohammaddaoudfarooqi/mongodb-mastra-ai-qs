#!/bin/sh
# Studio container entrypoint.
#
# Problem: `mastra dev` re-bundles studio/index.html from scratch on EVERY start,
# baking in the raw placeholders %%MASTRA_AUTO_DETECT_URL%% and %%MASTRA_SERVER_HOST%%.
# It then templates them per-request to serverHost=localhost, so a remote browser is
# prompted for the Mastra instance URL (the "config again" prompt). The userdata sed
# patch only ran on first boot, so any studio restart brought the prompt back.
#
# Fix: patch the served file on every container start, right after the dev server
# bundles it. Setting MASTRA_AUTO_DETECT_URL=true makes the client use
# window.location.origin (whatever host/port the browser loaded Studio from), so it
# self-connects with no prompt. MASTRA_SERVER_HOST is a fallback host, optionally
# supplied via STUDIO_PUBLIC_HOST (e.g. the EC2 public DNS).
set -eu

IDX="/app/.mastra/output/studio/index.html"
HOST="${STUDIO_PUBLIC_HOST:-}"

patch_studio() {
  # Wait for `mastra dev` to bundle the file (a few seconds after start), then bake
  # concrete values into the placeholders so the per-request templater has nothing to
  # override. Re-check for a while in case the dev server rewrites it during warmup.
  i=0
  while [ "$i" -lt 60 ]; do
    if [ -f "$IDX" ] && grep -q '%%MASTRA_AUTO_DETECT_URL%%' "$IDX"; then
      sed -i "s/%%MASTRA_AUTO_DETECT_URL%%/true/g; s/%%MASTRA_SERVER_HOST%%/$HOST/g" "$IDX"
      echo "[studio-entrypoint] patched $IDX (auto-detect=true host=$HOST)"
    fi
    i=$((i + 1))
    sleep 2
  done
}

# Run the patcher in the background; it survives the dev server's initial bundle and
# keeps re-patching for ~2 min in case of a late rewrite.
patch_studio &

exec pnpm exec mastra dev
