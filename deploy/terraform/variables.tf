# ─────────────────────────────────────────────────────────────────────────────
# Inputs. Non-secret values live in terraform.tfvars (copy from the .example).
# Secrets (atlas keys, voyage key, BYO mongo uri) come from TF_VAR_* env or a
# gitignored terraform.tfvars — NEVER commit filled secret values.
# ─────────────────────────────────────────────────────────────────────────────

# ── Toggles / region / naming ────────────────────────────────────────────────
variable "create_atlas_cluster" {
  description = "true: Terraform provisions a new Atlas M10 + VPC peering. false: BYO — skip all Atlas/peering resources and use mongodb_uri_byo."
  type        = bool
  default     = true
}

variable "aws_region" {
  description = "AWS region. Co-locate with Atlas + Bedrock; us-west-2 has full Claude Bedrock availability."
  type        = string
  default     = "us-west-2"
}

variable "availability_zone" {
  description = "AZ for the subnet + EC2 instance."
  type        = string
  default     = "us-west-2a"
}

variable "name_prefix" {
  description = "Prefix for resource names, tags, and the SSM parameter path."
  type        = string
  default     = "mastra-ai4"
}

# ── Governance tags (required by the account's tag-reaper policy) ─────────────
variable "owner_email" {
  description = "Owner email — applied as owner + OwnerContact tags on every resource."
  type        = string
  default     = "mohammaddaoud.farooqi@mongodb.com"
}

variable "purpose" {
  description = "purpose tag value."
  type        = string
  default     = "partners"
}

variable "expire_on" {
  description = "expire-on tag (YYYY-MM-DD) read by the account resource-reaper. Set to just after the demo, not far future."
  type        = string
  default     = "2026-08-31"
}

# ── Access control ────────────────────────────────────────────────────────────
variable "admin_cidr" {
  description = "Deploy machine's CIDR (usually its public IP /32) allowed for SSH (22) and, in create mode, added to the Atlas access list so this host can seed the cluster over the public path. The wrapper auto-detects a /32 when unset. All app ports are additionally reachable from office_cidrs."
  type        = string
}

variable "office_cidrs" {
  description = "Corporate/VPN network ranges allowed to reach every app port (22/80/443/8000/4111). Nothing is world-open; access is over these ranges. Set the actual list in the gitignored terraform.tfvars (kept out of version control); empty ⇒ no office/VPN ingress (admin_cidr SSH only)."
  type        = list(string)
  default     = []
}

# ── Networking (CIDR non-overlap is load-bearing for peering) ─────────────────
variable "vpc_cidr" {
  description = "AWS VPC CIDR. Must NOT overlap atlas_cidr."
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "Public subnet CIDR within the VPC."
  type        = string
  default     = "10.0.1.0/24"
}

variable "atlas_cidr" {
  description = "CIDR for the Atlas network container (the peered network). Atlas AWS containers require a /21. Must NOT overlap vpc_cidr."
  type        = string
  default     = "192.168.248.0/21"
}

# ── Atlas ─────────────────────────────────────────────────────────────────────
variable "atlas_public_key" {
  description = "Atlas Programmatic API public key."
  type        = string
  default     = ""
  sensitive   = true
}

variable "atlas_private_key" {
  description = "Atlas Programmatic API private key."
  type        = string
  default     = ""
  sensitive   = true
}

variable "atlas_org_id" {
  description = "Atlas org id — used only when creating a new project (atlas_project_id empty)."
  type        = string
  default     = ""
}

variable "atlas_project_id" {
  description = "Existing Atlas project id to deploy into. Empty ⇒ Terraform creates a project (needs atlas_org_id)."
  type        = string
  default     = ""
}

variable "atlas_project_name" {
  description = "Name for the Atlas project when creating one."
  type        = string
  default     = "mastra-ai4"
}

variable "atlas_cluster_name" {
  description = "Atlas cluster name."
  type        = string
  default     = "mastra-ai4-cluster"
}

variable "atlas_db_username" {
  description = "Atlas database user for the app."
  type        = string
  default     = "mastra_concierge"
}

variable "atlas_db_password" {
  description = "Password for the Atlas database user. Leave empty and let the wrapper generate an alphanumeric one (avoids URL-encoding in the connection string)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "mongodb_uri_byo" {
  description = "BYO connection string (mongodb+srv://user:pass@host/...). Used only when create_atlas_cluster = false."
  type        = string
  default     = ""
  sensitive   = true
}

# ── App config (non-secret) — mirrors .env.example ────────────────────────────
variable "mongodb_database" {
  type    = string
  default = "mongodb_mastra_qs"
}

variable "voyage_base_url" {
  type    = string
  default = "https://ai.mongodb.com/v1"
}

variable "memory_embed_model" {
  type    = string
  default = "voyage-3.5"
}

variable "llm_provider" {
  type    = string
  default = "bedrock"
}

variable "bedrock_model_id" {
  description = "Bedrock cross-region inference-profile id. Verify against `aws bedrock list-inference-profiles --region <region>` before deploy."
  type        = string
  default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "response_cache_enabled" {
  type    = string
  default = "true"
}

variable "response_cache_ttl_days" {
  type    = string
  default = "1"
}

variable "response_cache_similarity_threshold" {
  type    = string
  default = "0.92"
}

variable "memory_semantic_recall" {
  type    = string
  default = "false"
}

variable "memory_last_messages" {
  type    = string
  default = "10"
}

variable "rrf_k" {
  type    = string
  default = "60"
}

variable "data_agent_allow_list" {
  type    = string
  default = "products,orders,promotions"
}

variable "data_agent_limit" {
  type    = string
  default = "25"
}

variable "default_user_id" {
  type    = string
  default = "demo"
}

variable "auth_mode" {
  type    = string
  default = "local"
}

variable "app_port" {
  type    = string
  default = "8000"
}

# ── App logging to MongoDB ────────────────────────────────────────────────────
# App logs always go to stdout/stderr (Docker json-file on the box); when enabled they are
# ALSO persisted to a MongoDB collection (buffered, fail-open, TTL-pruned) so logs survive
# container restarts and are queryable in Atlas.
variable "app_log_mongo_enabled" {
  type    = string
  default = "true"
}

variable "app_log_collection" {
  type    = string
  default = "app_logs"
}

variable "app_log_retention_days" {
  type    = string
  default = "30"
}

# ── App secret (→ SSM SecureString) ───────────────────────────────────────────
variable "voyage_api_key" {
  description = "Voyage API key (works against the MongoDB-hosted endpoint)."
  type        = string
  sensitive   = true
}

# ── Build / instance ──────────────────────────────────────────────────────────
variable "app_repo_url" {
  description = "HTTPS git URL of the app repo to clone + build on the instance."
  type        = string
}

variable "app_repo_ref" {
  description = "Branch/tag/sha to deploy."
  type        = string
  default     = "main"
}

variable "instance_type" {
  description = "EC2 instance type. m6i.large (fixed CPU, 8 GiB) handles the on-box docker build; t3.large can stall on CPU credits."
  type        = string
  default     = "m6i.large"
}

variable "ami_id" {
  description = "Optional explicit AMI id. Empty ⇒ resolve the latest Amazon Linux 2023 x86_64 via ec2:DescribeImages. Set this in environments whose IAM can't DescribeImages, or to pin a specific AMI."
  type        = string
  default     = ""
}

variable "key_pair_name" {
  description = "Existing EC2 key pair to use. Empty ⇒ create one from public_key_path."
  type        = string
  default     = ""
}

variable "public_key_path" {
  description = "Local SSH public key uploaded when key_pair_name is empty."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}
