locals {
  use_atlas = var.create_atlas_cluster

  # Atlas region form: us-west-2 → US_WEST_2.
  atlas_region = upper(replace(var.aws_region, "-", "_"))

  # Atlas permits only ONE network container per (project, provider, region). A reused
  # project may already have one for our region (from prior peering); creating another
  # 409s (OVERLAPPING_ATLAS_CIDR_BLOCK / DUPLICATE). So look up existing AWS containers
  # and, if one matches our region, reuse it (its id + its CIDR) instead of creating.
  _existing_containers = local.use_atlas ? [
    for c in data.mongodbatlas_network_containers.aws[0].results : c
    if c.region_name == local.atlas_region
  ] : []
  # NOTE: the data source's element id field is `id` (the resource's is `container_id`).
  _existing_container_id   = length(local._existing_containers) > 0 ? local._existing_containers[0].id : ""
  _existing_container_cidr = length(local._existing_containers) > 0 ? local._existing_containers[0].atlas_cidr_block : ""

  create_container   = local.use_atlas && local._existing_container_id == ""
  atlas_container_id = local.create_container ? (local.use_atlas ? mongodbatlas_network_container.aws[0].container_id : "") : local._existing_container_id
  # CIDR actually routed to Atlas: the new container uses var.atlas_cidr; a reused one
  # keeps whatever CIDR it was created with.
  atlas_cidr_effective = local.create_container ? var.atlas_cidr : local._existing_container_cidr

  # Project id: reuse the passed-in id, else the project Terraform creates.
  project_id = var.create_atlas_cluster && var.atlas_project_id == "" ? mongodbatlas_project.this[0].id : var.atlas_project_id

  ssm_prefix = "/${var.name_prefix}/env"

  # Governance tags required by the account's reaper policy. Applied to AWS resources via
  # the provider default_tags, and to the Atlas cluster via its own tags block (default_tags
  # covers only AWS). Keys match the account convention: owner, OwnerContact, purpose, expire-on.
  common_tags = {
    Project      = var.name_prefix
    ManagedBy    = "terraform"
    Env          = "ai4-demo"
    owner        = var.owner_email
    OwnerContact = var.owner_email
    purpose      = var.purpose
    "expire-on"  = var.expire_on
  }

  # Compose the authenticated SRV URI from the cluster's standard_srv output.
  # standard_srv is "mongodb+srv://<host>" (no creds); we splice in user:pass@ after the
  # scheme. The password is alphanumeric (wrapper-generated) so no URL-encoding is needed.
  # This value only ever flows into an SSM SecureString — never an output.
  _srv_host   = local.use_atlas ? replace(mongodbatlas_advanced_cluster.cluster[0].connection_strings.standard_srv, "mongodb+srv://", "") : ""
  mongodb_uri = local.use_atlas ? "mongodb+srv://${var.atlas_db_username}:${var.atlas_db_password}@${local._srv_host}/?retryWrites=true&w=majority" : var.mongodb_uri_byo

  # Bedrock ARNs for the scoped instance-role policy. A cross-region inference profile
  # invokes the underlying foundation model in multiple regions, so the FM resource keeps
  # the wildcard-region form (arn:aws:bedrock:*::foundation-model/...) the profile requires.
  bedrock_profile_arn = "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/${var.bedrock_model_id}"
  bedrock_fm_arn      = "arn:aws:bedrock:*::foundation-model/anthropic.claude-*"

  # Atlas rejects tags with blank values (HTTP 400 TAG_VALUE_BLANK), so drop any empty
  # value from the common set before handing it to the cluster.
  atlas_tags = { for k, v in local.common_tags : k => v if v != null && v != "" }

  # Non-secret env → SSM String params. Keys match what the app's config.ts reads.
  plain_params = {
    MONGODB_DATABASE                    = var.mongodb_database
    VOYAGE_BASE_URL                     = var.voyage_base_url
    MEMORY_EMBED_MODEL                  = var.memory_embed_model
    LLM_PROVIDER                        = var.llm_provider
    LLM_MODEL                           = var.bedrock_model_id
    AWS_REGION                          = var.aws_region
    BEDROCK_REGION                      = var.aws_region
    RESPONSE_CACHE_ENABLED              = var.response_cache_enabled
    RESPONSE_CACHE_TTL_DAYS             = var.response_cache_ttl_days
    RESPONSE_CACHE_SIMILARITY_THRESHOLD = var.response_cache_similarity_threshold
    MEMORY_SEMANTIC_RECALL              = var.memory_semantic_recall
    MEMORY_LAST_MESSAGES                = var.memory_last_messages
    RRF_K                               = var.rrf_k
    DATA_AGENT_ALLOW_LIST               = var.data_agent_allow_list
    DATA_AGENT_LIMIT                    = var.data_agent_limit
    DEFAULT_USER_ID                     = var.default_user_id
    AUTH_MODE                           = var.auth_mode
    PORT                                = var.app_port
  }

  # Secret env → SSM SecureString params.
  secure_params = {
    MONGODB_URI    = local.mongodb_uri
    VOYAGE_API_KEY = var.voyage_api_key
  }
}
