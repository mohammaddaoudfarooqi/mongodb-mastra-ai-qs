#!/usr/bin/env bash
# One-command deploy: AWS (VPC/EC2/SSM/IAM) + MongoDB Atlas M10 + VPC peering + Bedrock.
#
#   TF_VAR_atlas_public_key=... TF_VAR_atlas_private_key=... TF_VAR_atlas_org_id=... \
#   TF_VAR_voyage_api_key=... deploy/scripts/deploy.sh
#
# Reads non-secret config from deploy/terraform/terraform.tfvars (copy the .example).
# Secrets come from TF_VAR_* env or a gitignored terraform.tfvars. Pass --yes to skip
# the apply confirmation.
set -euo pipefail

# ── paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_DIR=$(cd "$DEPLOY_DIR/.." && pwd)
TF_DIR="$DEPLOY_DIR/terraform"
LOG="$DEPLOY_DIR/deploy.log"
: > "$LOG"

AUTO_YES=false
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && AUTO_YES=true

# ── output helpers (color only on a TTY; everything also tee'd to the log) ──────
if [[ -t 1 ]]; then C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[36m'; C_0=$'\033[0m'; else C_G=; C_Y=; C_R=; C_B=; C_0=; fi
log()  { echo "${C_B}▸${C_0} $*" | tee -a "$LOG"; }
ok()   { echo "${C_G}✓${C_0} $*" | tee -a "$LOG"; }
warn() { echo "${C_Y}!${C_0} $*" | tee -a "$LOG"; }
die()  { echo "${C_R}✗ $*${C_0}" | tee -a "$LOG" >&2; exit 1; }

tf() { terraform -chdir="$TF_DIR" "$@"; }

# ── read a var from terraform.tfvars (non-secret config) ────────────────────────
tfvar() {
  local key="$1" f="$TF_DIR/terraform.tfvars"
  [[ -f "$f" ]] || return 0
  grep -m1 -E "^[[:space:]]*${key}[[:space:]]*=" "$f" 2>/dev/null \
    | sed -E "s/^[^=]*=[[:space:]]*//; s/^\"//; s/\"[[:space:]]*(#.*)?$//; s/[[:space:]]*(#.*)?$//" || true
}

# ── CIDRs don't overlap (peering breaks silently if they do) ────────────────────
assert_no_overlap() {
  local a="$1" b="$2"
  # Cheap, sufficient check for the demo defaults (10.0.0.0/16 vs 192.168.248.0/21):
  # compare the first octet. A full CIDR-math check is overkill here.
  local oa=${a%%.*} ob=${b%%.*}
  [[ "$oa" != "$ob" ]] || die "atlas_cidr ($a) and vpc_cidr ($b) may overlap (same first octet). Pick non-overlapping ranges."
}

# ────────────────────────────────────────────────────────────────────────────────
# 1. PREFLIGHT
# ────────────────────────────────────────────────────────────────────────────────
preflight() {
  log "preflight"
  for bin in terraform aws jq ssh curl; do command -v "$bin" >/dev/null || die "missing required tool: $bin"; done
  command -v pnpm >/dev/null || warn "pnpm not found — the data-bootstrap step (seed/embed) will be skipped; run it manually later."

  aws sts get-caller-identity >/dev/null 2>&1 || die "AWS credentials not configured (aws sts get-caller-identity failed)."
  local acct; acct=$(aws sts get-caller-identity --query Account --output text)
  ok "AWS account $acct"

  local region create byo
  region=$(tfvar aws_region); region=${region:-us-west-2}
  create=$(tfvar create_atlas_cluster); create=${create:-true}
  [[ "$region" == "us-west-2" ]] || warn "aws_region=$region (Bedrock Claude availability is best in us-west-2)."

  # Required inputs by mode.
  if [[ "$create" == "true" ]]; then
    [[ -n "${TF_VAR_atlas_public_key:-}"  ]] || die "TF_VAR_atlas_public_key is required (create mode)."
    [[ -n "${TF_VAR_atlas_private_key:-}" ]] || die "TF_VAR_atlas_private_key is required (create mode)."
    [[ -n "${TF_VAR_atlas_project_id:-}" || -n "$(tfvar atlas_project_id)" || -n "${TF_VAR_atlas_org_id:-}" ]] || die "Set TF_VAR_atlas_project_id (deploy into an existing project) or TF_VAR_atlas_org_id (create a new project, needs the Project-Creator org role)."
    assert_no_overlap "$(tfvar atlas_cidr | grep -o '[0-9.]*/[0-9]*' || echo 192.168.248.0/21)" "$(tfvar vpc_cidr | grep -o '[0-9.]*/[0-9]*' || echo 10.0.0.0/16)"
  else
    [[ -n "${TF_VAR_mongodb_uri_byo:-}" ]] || die "create_atlas_cluster=false requires TF_VAR_mongodb_uri_byo."
  fi
  [[ -n "${TF_VAR_voyage_api_key:-}" ]] || die "TF_VAR_voyage_api_key is required."

  # admin_cidr: auto-detect the deploy machine's public IP as /32 if not set.
  if [[ -z "${TF_VAR_admin_cidr:-}" && -z "$(tfvar admin_cidr)" ]]; then
    local ip; ip=$(curl -fsS https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')
    [[ -n "$ip" ]] || die "Could not auto-detect your public IP; set admin_cidr in tfvars or TF_VAR_admin_cidr."
    export TF_VAR_admin_cidr="${ip}/32"
    warn "admin_cidr auto-detected as $TF_VAR_admin_cidr (SSH + Atlas seed access)."
  fi

  # Generate an alphanumeric Atlas DB password if not provided (avoids URL-encoding).
  if [[ "$create" == "true" && -z "${TF_VAR_atlas_db_password:-}" && -z "$(tfvar atlas_db_password)" ]]; then
    export TF_VAR_atlas_db_password=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 28)
    ok "generated Atlas DB password (28 alnum chars)"
  fi

  # Bedrock model-access probe — the longest-lead-time failure. Abort NOW if the profile
  # isn't enabled in the account/region (enablement can take hours–days).
  local model; model=$(tfvar bedrock_model_id); model=${model:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}
  local provider; provider=$(tfvar llm_provider); provider=${provider:-bedrock}
  if [[ "$provider" == "bedrock" ]]; then
    if aws bedrock list-inference-profiles --region "$region" >/dev/null 2>&1; then
      if ! aws bedrock list-inference-profiles --region "$region" --query 'inferenceProfileSummaries[].inferenceProfileId' --output text 2>/dev/null | tr '\t' '\n' | grep -qx "$model"; then
        warn "Bedrock profile '$model' not found among enabled profiles in $region."
        warn "Enable Claude model access: https://console.aws.amazon.com/bedrock/home?region=$region#/modelaccess"
        $AUTO_YES || { read -r -p "Continue anyway? [y/N] " a; [[ "$a" == "y" || "$a" == "Y" ]] || die "aborted — enable Bedrock model access first."; }
      else
        ok "Bedrock profile enabled: $model"
      fi
    else
      warn "could not list Bedrock inference profiles (permissions?) — skipping the access probe."
    fi
  fi
  ok "preflight passed"
}

# ────────────────────────────────────────────────────────────────────────────────
# 2. APPLY (with transient-error retry for Atlas/peering propagation)
# ────────────────────────────────────────────────────────────────────────────────
apply_with_retry() {
  local attempt=1 max=3
  while :; do
    if tf apply -auto-approve tfplan 2>&1 | tee -a "$LOG"; then return 0; fi
    # Only retry on known-transient propagation/throttle errors; anything else is real.
    if (( attempt < max )) && tail -n 40 "$LOG" | grep -qiE "CANNOT_.*_YET|PEER.*PENDING|Throttling|RequestLimitExceeded|timeout|try again"; then
      warn "transient error on apply (attempt $attempt/$max); re-planning + retrying in $((30*attempt))s"
      sleep $((30 * attempt)); attempt=$((attempt + 1))
      tf plan -out tfplan >>"$LOG" 2>&1 || die "re-plan failed"
      continue
    fi
    die "terraform apply failed (see $LOG)"
  done
}

# ────────────────────────────────────────────────────────────────────────────────
# 3. WAITS + BOOTSTRAP + HEALTH
# ────────────────────────────────────────────────────────────────────────────────
wait_peering_active() {
  local create; create=$(tfvar create_atlas_cluster); create=${create:-true}
  [[ "$create" == "true" ]] || return 0
  local pcx region i
  pcx=$(tf output -raw vpc_peering_connection_id 2>/dev/null || echo "")
  region=$(tfvar aws_region); region=${region:-us-west-2}
  [[ -n "$pcx" ]] || { warn "no peering connection id in outputs; skipping ACTIVE wait"; return 0; }
  log "waiting for VPC peering $pcx to become active"
  for i in $(seq 1 30); do
    local st; st=$(aws ec2 describe-vpc-peering-connections --region "$region" \
      --vpc-peering-connection-ids "$pcx" --query 'VpcPeeringConnections[0].Status.Code' --output text 2>/dev/null || echo "")
    [[ "$st" == "active" ]] && { ok "peering active"; return 0; }
    sleep 10
  done
  warn "peering not active after ~5 min; continuing (seed step may need a retry)."
}

wait_boot() {
  local ip; ip=$(tf output -raw public_ip)
  log "waiting for EC2 bootstrap (ssh ec2-user@$ip; tailing /var/log/deploy.log)"
  local i
  for i in $(seq 1 60); do
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "ec2-user@$ip" \
        'grep -q "== userdata done ==" /var/log/deploy.log 2>/dev/null' 2>/dev/null; then
      ok "instance bootstrap complete"; return 0
    fi
    sleep 15
  done
  warn "bootstrap marker not seen after ~15 min; check: ssh ec2-user@$ip 'tail -f /var/log/deploy.log'"
}

bootstrap_data() {
  command -v pnpm >/dev/null || { warn "pnpm missing — skipping seed/embed. Run manually against Atlas."; return 0; }
  local uri db voyage
  uri=$(get_mongodb_uri)
  db=$(tfvar mongodb_database); db=${db:-mongodb_mastra_qs}
  voyage="${TF_VAR_voyage_api_key:-}"
  [[ -n "$uri" ]] || { warn "no MONGODB_URI available; skipping data bootstrap."; return 0; }
  log "seeding Atlas from this machine (provision → seed → embed → prewarm)"
  ( cd "$REPO_DIR" && MONGODB_URI="$uri" MONGODB_DATABASE="$db" VOYAGE_API_KEY="$voyage" \
      pnpm provision && pnpm seed && pnpm embed && pnpm prewarm ) 2>&1 | tee -a "$LOG" \
    || warn "data bootstrap had errors — inspect $LOG; you can re-run it from the repo root."
  ok "data bootstrap done"
}

# Rebuild the authed URI locally for the seed step (never printed to stdout).
get_mongodb_uri() {
  local create; create=$(tfvar create_atlas_cluster); create=${create:-true}
  if [[ "$create" != "true" ]]; then echo "${TF_VAR_mongodb_uri_byo:-}"; return; fi
  local srv host user pass
  srv=$(tf output -raw atlas_srv 2>/dev/null || echo "")
  [[ -n "$srv" ]] || { echo ""; return; }
  host=${srv#mongodb+srv://}
  user=$(tfvar atlas_db_username); user=${user:-mastra_app}
  pass="${TF_VAR_atlas_db_password:-}"
  [[ -n "$pass" ]] || pass=$(tfvar atlas_db_password)
  echo "mongodb+srv://${user}:${pass}@${host}/?retryWrites=true&w=majority"
}

health_poll() {
  local ip; ip=$(tf output -raw public_ip)
  log "waiting for the app to answer on http://$ip/api/health"
  local i
  for i in $(seq 1 40); do
    if curl -fsS "http://$ip/api/health" >/dev/null 2>&1; then ok "app healthy"; return 0; fi
    sleep 15
  done
  warn "health check did not pass after ~10 min; check: ssh ec2-user@$ip 'docker compose -f /opt/app/src/docker-compose.yml -f /opt/app/src/deploy/compose.nginx.yml logs'"
}

# ────────────────────────────────────────────────────────────────────────────────
main() {
  echo "${C_B}=== Mastra concierge → AWS one-command deploy ===${C_0}"
  preflight
  log "terraform init"; tf init -input=false >>"$LOG" 2>&1 || die "terraform init failed"
  log "terraform validate"; tf validate >>"$LOG" 2>&1 || die "terraform validate failed"
  log "terraform plan"; tf plan -input=false -out tfplan 2>&1 | tee -a "$LOG" || die "terraform plan failed"
  if ! $AUTO_YES; then
    read -r -p "Apply this plan? (creates billable AWS + Atlas resources) [y/N] " a
    [[ "$a" == "y" || "$a" == "Y" ]] || die "aborted before apply."
  fi
  warn "provisioning — the Atlas M10 takes ~7–15 min; the on-box docker build ~5–8 min. Sit tight."
  apply_with_retry
  wait_peering_active
  wait_boot
  bootstrap_data
  health_poll

  local dns; dns=$(tf output -raw public_dns)
  echo ""
  ok "Deployed."
  echo "   App URL : ${C_G}http://$dns/${C_0}"
  echo "   Studio  : http://$dns:4111/   (Mastra dev/observability UI)"
  echo "   SSH     : ssh ec2-user@$dns"
  echo "   Verify  : BASE_URL=http://$dns pnpm verify:demo"
  echo "   Logs    : ssh ec2-user@$dns 'tail -f /var/log/deploy.log'"
}
main "$@"
