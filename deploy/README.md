# One-command AWS deploy — EC2 + MongoDB Atlas + VPC peering + Bedrock

Provisions the whole stack in one `terraform apply`, wrapped by `deploy.sh`:

- A VPC (public subnet) and an EC2 box (`m6i.large`, Amazon Linux 2023) that builds and runs
  the app in Docker, behind nginx on port 80.
- **Mastra Studio** (the dev/observability UI — agent traces, tool inspection, the visual
  workflow runner) on port 4111, started by default for the demo.
- A new **MongoDB Atlas M10** cluster co-located with the app, connected over **AWS↔Atlas VPC
  peering** so app↔DB round-trips are ~1–5 ms instead of ~250 ms over the public internet.
- The LLM on **AWS Bedrock** via the EC2 **instance role** (no API key on the box).
- App secrets delivered through **SSM Parameter Store** (SecureString); UserData hydrates
  `/opt/app/.env` at boot.

Why: co-locating the app with Atlas and moving the LLM in-region is the biggest latency lever
for the live demo.

## Prerequisites

- `terraform` ≥ 1.13, `aws` CLI (configured: `aws sts get-caller-identity` works), `jq`, `ssh`,
  `curl`, and `pnpm` (for the data-seed step) on the deploy machine.
- A MongoDB Atlas **Programmatic API Key** (public + private) and an existing **project id**
  (recommended — `TF_VAR_atlas_project_id`). To create a new project instead, supply an org id
  (`TF_VAR_atlas_org_id`); that path needs the Project-Creator role in the org.
- A Voyage API key.
- **Bedrock model access enabled** for Claude in your target region — this can take hours to
  approve, so do it first: <https://console.aws.amazon.com/bedrock/home?region=us-west-2#/modelaccess>

## Deploy

```bash
cp deploy/terraform/terraform.tfvars.example deploy/terraform/terraform.tfvars
# edit terraform.tfvars: app_repo_url, region, cluster names, etc. (non-secret)

export TF_VAR_atlas_public_key=...      # secrets via env, never in the file
export TF_VAR_atlas_private_key=...
export TF_VAR_atlas_project_id=...      # deploy into an existing project (recommended)
                                        #   — or TF_VAR_atlas_org_id to create a new one
                                        #     (needs the Project-Creator org role)
export TF_VAR_voyage_api_key=...

deploy/scripts/deploy.sh                # add --yes to skip the apply confirmation
```

The wrapper runs: preflight (tool + credential checks, a **Bedrock model-access probe** that
aborts early if any picker model — Sonnet AND Haiku — isn't enabled, CIDR-overlap assertion,
auto-detects your public IP for SSH/seed access, generates the Atlas DB password) →
`terraform apply` (with a transient-error retry for Atlas/peering propagation) → wait for peering
**ACTIVE** → wait for the box's bootstrap marker → **seed Atlas from your machine**
(`provision`/`seed`/`embed`/`prewarm`) → health-poll the public URL. It prints the app URL, SSH
command, and a `verify:demo` reminder.

The Atlas DB user defaults to `mastra_concierge`. The password is generated once (28 alphanumeric
chars, no URL-encoding needed) and persisted to `deploy/.deploy-secrets.env` (gitignored), so every
later run and any bare `terraform apply` reuses the same password instead of resetting the DB user.
Set `TF_VAR_atlas_db_password` to pin your own; set `atlas_db_username` in tfvars to rename the user.

Expect ~15–20 min end to end: the Atlas M10 is ~7–15 min and the on-box docker build ~5–8 min.

## BYO cluster

Set `create_atlas_cluster = false` in tfvars and pass `TF_VAR_mongodb_uri_byo=mongodb+srv://…`.
All Atlas + peering resources are skipped; the app uses your connection string. (You lose the
private peered path — the box reaches your cluster over its public endpoint, so allowlist the
EC2 egress IP in your Atlas project yourself.)

## Verify

```bash
BASE_URL=http://<public-ip> pnpm verify:demo   # drives every demo beat over the real path
ssh ec2-user@<public-ip> 'getent hosts <cluster-shard-host>'   # should resolve into 192.168.248.x (private)
```

- Storefront: `http://<public-ip>/`
- Mastra Studio: `http://<public-ip>:4111/`

Nothing is world-open. Every app port (22/80/443/8000/4111) is scoped to `office_cidrs` — the
corporate/VPN network ranges — so the storefront and Studio are reachable only from that network.
Set `office_cidrs` in your (gitignored) `terraform.tfvars`; the list is kept local and never
committed. The deploy machine's `admin_cidr` additionally gets SSH and the Atlas seed path.

## Teardown

```bash
deploy/scripts/destroy.sh                # type 'destroy' to confirm; --yes to skip
```

Destroys the cluster (all data), EC2, VPC/peering, SSM params, and IAM, then sweeps any dangling
peering connection. Needs the same `TF_VAR_atlas_*` keys so the provider can delete Atlas.

## Notes & gotchas

- **CIDRs must not overlap:** `atlas_cidr` (`192.168.248.0/21`, Atlas requires a /21) vs
  `vpc_cidr` (`10.0.0.0/16`). The wrapper asserts this.
- **Connection string:** the app uses the standard `mongodb+srv://` SRV; once peering is active
  and the access list admits the VPC CIDR, those hostnames resolve to private `192.168.248.x`
  IPs and traffic routes over the peering — no PrivateLink `private` string is used.
- **Conference-network fallback:** the seed step runs from your laptop over Atlas's public path
  (allowlisted via your `/32`). If the venue blocks outbound Atlas, run seed/embed from the box
  instead (ssh in, use a one-shot tooling container), or seed ahead of time from a good network.
- **State is local** (`deploy/terraform/terraform.tfstate`, gitignored). Keep it — it's how
  `destroy.sh` finds what to remove.
- Secrets live only in SSM SecureString and `TF_VAR_*`; nothing secret is committed, output, or
  baked into UserData.

## Bedrock model ids

Bedrock rejects the plain Anthropic ids (`claude-sonnet-4-6`); it needs cross-region
inference-profile ids (`us.anthropic.claude-sonnet-4-5-…-v1:0`). Confirm what's enabled:

```bash
aws bedrock list-inference-profiles --region us-west-2 \
  --query 'inferenceProfileSummaries[].inferenceProfileId' --output text
```

Set the chosen id as `bedrock_model_id` in tfvars (it flows to `LLM_MODEL` on the box, and the
app's `BEDROCK_MODEL_CATALOG` surfaces the picker options).

**Enable model access for the WHOLE catalog, not just the default.** The UI model picker
offers every id in `BEDROCK_MODEL_CATALOG` — currently **both** Sonnet 4.5 and Haiku 4.5. The
instance-role policy authorizes invoke on all `us.anthropic.claude-*` inference profiles
(`locals.tf` `bedrock_profile_arn` uses a wildcard), and `deploy.sh` preflight probes that both
profiles are enabled. If you enable only Sonnet, switching the picker to Haiku returns a Bedrock
403 (`AI_APICallError: Forbidden`). Enable access for every model you expose in the picker.

## App logs + observability

- **App logs → MongoDB:** logs always go to the container's stdout/stderr (`docker compose logs
  -f app`). When `APP_LOG_MONGO_ENABLED=true` (default) they are also written to the
  `APP_LOG_COLLECTION` collection (default `app_logs`) in the app database — buffered,
  fail-open, and TTL-pruned after `APP_LOG_RETENTION_DAYS` (default 30). Query them in Atlas or
  `db.app_logs.find().sort({ts:-1})`. These flow from tfvars → SSM → `/opt/app/.env`.
- **Studio metrics:** the app configures an in-memory observability store for the metrics
  domain (MongoDB persists traces/spans but not metrics), so Mastra Studio's metrics panel
  populates. In-memory metrics are per-process and reset on restart — expected for the demo.
