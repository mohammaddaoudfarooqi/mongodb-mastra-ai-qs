const API_BASE = '/api';

/**
 * Optional SSO auth header (deployment-specific).
 *
 * In an SSO deployment the platform gateway injects the auth JWT server-side, so the
 * browser normally sends nothing. Locally there is no gateway. A developer can exercise
 * the real-JWT path by setting `VITE_DEV_FAKE_JWT` (dev builds only); the header name it
 * is sent under is configurable via `VITE_SSO_HEADER` (defaults to `x-sso-authorization`),
 * so no deployment-specific header name is hardcoded in this public code.
 */
function authHeaders(): Record<string, string> {
  const jwt = import.meta.env.DEV
    ? (import.meta.env.VITE_DEV_FAKE_JWT as string | undefined)
    : undefined;
  const header = (import.meta.env.VITE_SSO_HEADER as string | undefined) || 'x-sso-authorization';
  return jwt ? { [header]: jwt } : {};
}

/** The authenticated SSO user, returned by GET /api/auth/me. */
export interface CurrentUser {
  email: string;
  username: string;
  groups: string[];
  // When true (public AI4 domain), the SPA shows the attendee capture gate before the store.
  leadGate?: boolean;
  // When true (public AI4 domain), the SPA shows only the stateless, cache-safe demo prompts.
  curatedPresets?: boolean;
}

export interface LeadSubmission {
  name: string;
  email: string;
  company?: string;
  consent?: boolean;
}

/** POST /api/leads — attendee capture for the public demo (persists to Atlas, best-effort). */
export async function submitLead(lead: LeadSubmission): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ ...lead, source: 'ai4' }),
    });
    return (await res.json()) as { ok: boolean; reason?: string };
  } catch {
    // Fail-open on the client too: never trap an attendee behind a network hiccup.
    return { ok: true };
  }
}

/**
 * GET /api/auth/me — the authenticated SSO user. The app shows `email` as the
 * read-only user-id badge and sends it as `user_id` on chat/feedback requests.
 * Throws on a non-2xx (e.g. 401 when unauthenticated and dev-bypass is off).
 */
export async function fetchMe(): Promise<CurrentUser> {
  const res = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Not authenticated (HTTP ${res.status})`);
  return (await res.json()) as CurrentUser;
}

export interface Todo {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanSnapshot {
  todos: Todo[];
  updated_at: string | null;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface ModelsResponse {
  default: string;
  models: ModelOption[];
  // When false (e.g. the public AI4 domain), the UI must NOT offer a model picker —
  // every visitor runs the pinned default. Absent/true ⇒ switching allowed.
  allowSwitch?: boolean;
}

/**
 * GET /api/models: the LLM models verified to drive the Mastra agent tool
 * loop. Populates the header dropdown.
 */
export async function fetchModels(): Promise<ModelsResponse> {
  const res = await fetch(`${API_BASE}/models`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch models (HTTP ${res.status})`);
  return (await res.json()) as ModelsResponse;
}

export interface CatalogStats {
  products: number | null;
  categories: number | null;
  on_sale: number | null;
}

/**
 * GET /api/stats — live catalog counts (products / categories / on-sale) for
 * the landing-page header. Fields are null when the backend can't reach Mongo,
 * in which case callers should keep their static fallback values.
 */
export async function fetchStats(): Promise<CatalogStats> {
  const res = await fetch(`${API_BASE}/stats`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch stats (HTTP ${res.status})`);
  return (await res.json()) as CatalogStats;
}

export interface ChatRequest {
  user_id: string;
  thread_id?: string;
  message: string;
  // Spec 505: optional Bedrock inference-profile id selected in the UI.
  // When omitted the backend uses its default LLM_MODEL.
  model?: string;
}

export interface SavedFile {
  path: string;
  size: number;
  created_at: string;
}

export interface FilesResponse {
  files: SavedFile[];
}

/**
 * GET /api/files?user_id=&thread_id= — list the VFS files the agent wrote to
 * S3 + MongoDB for this conversation. Surfaced in the chat panel's
 * "Files Saved" strip as proof the agent persisted artifacts.
 *
 * Returns an empty list on any failure so the UI never breaks a turn over a
 * missing-files lookup.
 */
export async function fetchFiles(
  userId: string,
  threadId: string,
): Promise<SavedFile[]> {
  try {
    const params = new URLSearchParams({ user_id: userId, thread_id: threadId });
    const res = await fetch(`${API_BASE}/files?${params.toString()}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as FilesResponse;
    return Array.isArray(body.files) ? body.files : [];
  } catch {
    return [];
  }
}

/**
 * Spec 530: a single line in the shopping cart. Returned by GET /api/cart.
 * `sale_price_usd` is null when the line is at list price; `line_savings` and
 * `applied_coupons` are present when a promo lowered the line total.
 */
export interface CartLine {
  product_id: string;
  name: string;
  qty: number;
  unit_price_usd: number;
  sale_price_usd: number | null;
  applied_coupons?: string[];
  line_savings?: number;
  // Coupon $ off this line (present when a promo code was applied). Separate from
  // `line_savings` (sale savings) so the two are shown/summed distinctly.
  coupon_savings?: number;
}

/**
 * GET /api/cart payload — the conversation's current cart. Always 200; `lines`
 * is empty when no cart exists for the {user, thread} pair.
 */
export interface CartResponse {
  lines: CartLine[];
  subtotal: number;
  total_savings: number;
  // Coupon $ off the whole cart, and the amount actually charged (subtotal − coupon_savings).
  // Both are present once the backend applies a coupon; `total` falls back to `subtotal`.
  coupon_savings?: number;
  total?: number;
  updated_at: string | null;
}

/**
 * GET /api/cart?user_id=&thread_id= — the cart the agent built for this
 * conversation. `threadId` is the per-conversation sub (the same value passed
 * to /chat as thread_id), NOT the composite `{user}:{sub}`.
 *
 * Returns an empty cart on any failure so the UI never breaks a turn over a
 * missing-cart lookup.
 */
export async function fetchCart(
  userId: string,
  threadId: string,
): Promise<CartResponse> {
  const empty: CartResponse = {
    lines: [],
    subtotal: 0,
    total_savings: 0,
    coupon_savings: 0,
    total: 0,
    updated_at: null,
  };
  try {
    const params = new URLSearchParams({ user_id: userId, thread_id: threadId });
    const res = await fetch(`${API_BASE}/cart?${params.toString()}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return empty;
    const body = (await res.json()) as CartResponse;
    const subtotal = typeof body.subtotal === 'number' ? body.subtotal : 0;
    return {
      lines: Array.isArray(body.lines) ? body.lines : [],
      subtotal,
      total_savings: typeof body.total_savings === 'number' ? body.total_savings : 0,
      coupon_savings: typeof body.coupon_savings === 'number' ? body.coupon_savings : 0,
      total: typeof body.total === 'number' ? body.total : subtotal,
      updated_at: body.updated_at ?? null,
    };
  } catch {
    return empty;
  }
}

/**
 * A message as persisted in the agent-log doc and returned by GET /api/messages.
 * `type` is the projected message type (`human` | `ai` | `tool` | `system`);
 * the backend projects Mastra roles to these values (see src/server/projection.ts).
 */
export interface StoredMessage {
  type: string;
  content: string;
}

interface MessagesResponse {
  messages: StoredMessage[];
}

interface LatestThreadResponse {
  thread_id: string | null;
}

/**
 * GET /api/threads/latest?user_id= — the sub of this user's most recent
 * conversation, used to rehydrate the last chat on load. Returns null when the
 * user has no prior conversation. Swallows failures to null so a restore lookup
 * never breaks the initial render.
 */
export async function fetchLatestThread(userId: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ user_id: userId });
    const res = await fetch(`${API_BASE}/threads/latest?${params.toString()}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as LatestThreadResponse;
    return body.thread_id ?? null;
  } catch {
    return null;
  }
}

/**
 * GET /api/messages?user_id=&thread_id= — the persisted human/ai/tool transcript
 * for a conversation, used to restore it. Returns [] on any failure so a restore
 * never breaks the render.
 */
export async function fetchMessages(
  userId: string,
  threadId: string,
): Promise<StoredMessage[]> {
  try {
    const params = new URLSearchParams({ user_id: userId, thread_id: threadId });
    const res = await fetch(`${API_BASE}/messages?${params.toString()}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as MessagesResponse;
    return Array.isArray(body.messages) ? body.messages : [];
  } catch {
    return [];
  }
}

// Callbacks fire as SSE frames arrive. The stream contract is defined in
// server/app.py: `event: token`, `event: plan`, `event: status`,
// `event: done`, `event: error`.
export interface StatusEvent {
  phase: 'tool_start' | 'tool_end';
  name: string;
}

/**
 * Spec 530: a human-in-the-loop checkout pause. The agent emits this on a
 * `interrupt` SSE frame (NON-terminal — a `done` frame still follows) when it
 * needs the shopper to approve/edit/reject an action before proceeding.
 *
 * `thread_id` is the COMPOSITE value (`{user_id}:{sub}`) — it must be sent back
 * verbatim to POST /api/interrupts/resume; do NOT recompose it.
 */
export interface InterruptEvent {
  thread_id: string;
  action: {
    name: string;
    args: Record<string, unknown>;
    description: string;
  };
  allowed_decisions: string[];
}

/* ── SSE frame validators ──────────────────────────────────────────────────
 * The server frames are trusted, but a payload can be valid JSON yet the wrong
 * SHAPE (e.g. a model-influenced tool result). Validate before handing frames to
 * render code (reviewer finding #8), so a malformed-but-valid-JSON frame is dropped
 * instead of reaching PlanSection/StatusChip/ApprovalCard with missing fields. */
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function asPlanSnapshot(v: unknown): PlanSnapshot | null {
  if (!isObj(v) || !Array.isArray(v.todos)) return null;
  const todos = v.todos.filter(
    (t): t is Todo =>
      isObj(t) && typeof t.id === 'string' && typeof t.text === 'string' &&
      (t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed'),
  );
  return { todos, updated_at: typeof v.updated_at === 'string' ? v.updated_at : null };
}

function asStatusEvent(v: unknown): StatusEvent | null {
  if (!isObj(v) || typeof v.name !== 'string') return null;
  if (v.phase !== 'tool_start' && v.phase !== 'tool_end') return null;
  return { phase: v.phase, name: v.name };
}

function asInterruptEvent(v: unknown): InterruptEvent | null {
  if (!isObj(v) || typeof v.thread_id !== 'string' || !isObj(v.action)) return null;
  const a = v.action;
  if (typeof a.name !== 'string' || typeof a.description !== 'string' || !isObj(a.args)) return null;
  const decisions = Array.isArray(v.allowed_decisions)
    ? v.allowed_decisions.filter((d): d is string => typeof d === 'string')
    : [];
  return { thread_id: v.thread_id, action: { name: a.name, args: a.args, description: a.description }, allowed_decisions: decisions };
}

/**
 * A single agent-trace step for the in-chat "watch it work" panel. Emitted on a `trace`
 * SSE frame — one on tool start (with `args`) and one on tool end (with `summary` + `result`),
 * correlated by `id`. `oob` marks steps collected out-of-band from a sub-agent (see
 * src/server/trace.ts) — the frontend treats them identically.
 */
export interface TraceEvent {
  id?: string;
  phase: 'start' | 'end';
  tool: string;
  args?: unknown;
  summary?: string;
  result?: unknown;
  oob?: boolean;
}

function asTraceEvent(v: unknown): TraceEvent | null {
  if (!isObj(v) || typeof v.tool !== 'string') return null;
  if (v.phase !== 'start' && v.phase !== 'end') return null;
  return {
    id: typeof v.id === 'string' ? v.id : undefined,
    phase: v.phase,
    tool: v.tool,
    args: v.args,
    summary: typeof v.summary === 'string' ? v.summary : undefined,
    result: v.result,
    oob: v.oob === true,
  };
}

export interface StreamHandlers {
  onToken: (token: string) => void;
  // First frame of every /chat stream: the per-turn correlation id. Used as
  // the `run_id` when submitting feedback for this turn.
  onCorrelation?: (runId: string) => void;
  onPlan?: (plan: PlanSnapshot) => void;
  onStatus?: (status: StatusEvent) => void;
  // Fired per `trace` frame: a structured tool step (args on start, result+summary on end)
  // for the in-chat agent-trace panel.
  onTrace?: (trace: TraceEvent) => void;
  // Spec 530: fired on a non-terminal `interrupt` frame (checkout HITL pause).
  onInterrupt?: (ev: InterruptEvent) => void;
  onDone: () => void;
  onError: (detail: string) => void;
}

/**
 * POST /api/chat as a streaming fetch. Parses SSE frames on the fly.
 *
 * sse_starlette emits frames as:
 *   event: <name>\n
 *   data: <payload>\n
 *   \n
 *
 * We split the buffer on "\n\n" per frame and read `event:` + `data:` lines.
 * Unknown event names (e.g. sse_starlette's keepalives) are ignored.
 */
export async function streamChat(
  req: ChatRequest,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...authHeaders(),
      },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    // A deliberate abort (new conversation / unmount) is not an error.
    if (err instanceof DOMException && err.name === 'AbortError') return;
    handlers.onError(err instanceof Error ? err.message : 'network error');
    return;
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.detail) detail = String(body.detail);
    } catch {
      /* empty */
    }
    handlers.onError(detail);
    return;
  }

  if (!res.body) {
    handlers.onError('empty response body');
    return;
  }

  await consumeSSEStream(res, handlers);
}

/**
 * Shared SSE consumer for the streaming endpoints (POST /api/chat and
 * POST /api/interrupts/resume). Reads `res.body`, splits the buffer into
 * sse_starlette frames, and dispatches each `event:` to the matching handler.
 *
 * Terminal frames (`done` / `error`) stop the loop. The `interrupt` frame is
 * NON-terminal (a `done` frame still follows it), so it does not set
 * `sawTerminal`. If the stream ends without a terminal frame, that is surfaced
 * as an error rather than a phantom success (REQ-BUG-520-103).
 *
 * Callers must have already verified `res.ok` and `res.body`.
 */
async function consumeSSEStream(
  res: Response,
  handlers: StreamHandlers,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  // Track whether the server sent a terminal frame (done/error). If the stream
  // ends without one (dropped/truncated connection), that is an error — not a
  // silent success (REQ-BUG-520-103).
  let sawTerminal = false;

  // sse_starlette emits frames terminated by CRLF CRLF, but the SSE spec also
  // allows LF LF. Normalize CRLF → LF up front so the frame split is a single
  // string search on "\n\n".
  const findFrameEnd = (buf: string): number => buf.indexOf('\n\n');

  while (true) {
    let value: Uint8Array | undefined;
    let done: boolean;
    try {
      ({ value, done } = await reader.read());
    } catch (err) {
      // Deliberate abort mid-stream: silent return.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      handlers.onError(err instanceof Error ? err.message : 'stream read error');
      return;
    }
    if (done) break;
    // Normalize line endings inside the sliding buffer.
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

    let idx: number;
    while ((idx = findFrameEnd(buffer)) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = frame.split('\n');
      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      const data = dataLines.join('\n');
      if (eventName === 'token') handlers.onToken(data);
      else if (eventName === 'correlation') handlers.onCorrelation?.(data);
      else if (eventName === 'plan') {
        if (handlers.onPlan) {
          try {
            const parsed = asPlanSnapshot(JSON.parse(data));
            if (parsed) handlers.onPlan(parsed);
          } catch {
            /* malformed frame; ignore */
          }
        }
      } else if (eventName === 'status') {
        if (handlers.onStatus) {
          try {
            const parsed = asStatusEvent(JSON.parse(data));
            if (parsed) handlers.onStatus(parsed);
          } catch {
            /* malformed frame; ignore */
          }
        }
      } else if (eventName === 'trace') {
        if (handlers.onTrace) {
          try {
            const parsed = asTraceEvent(JSON.parse(data));
            if (parsed) handlers.onTrace(parsed);
          } catch {
            /* malformed frame; ignore */
          }
        }
      } else if (eventName === 'interrupt') {
        // NON-terminal: the agent paused for checkout approval. A `done` frame
        // still follows, so do NOT set sawTerminal here.
        if (handlers.onInterrupt) {
          try {
            const parsed = asInterruptEvent(JSON.parse(data));
            if (parsed) handlers.onInterrupt(parsed);
          } catch {
            /* malformed frame; ignore */
          }
        }
      } else if (eventName === 'done') {
        sawTerminal = true;
        handlers.onDone();
        return;
      } else if (eventName === 'error') {
        sawTerminal = true;
        handlers.onError(data);
        return;
      }
    }
  }

  // Stream ended without a done/error frame → the connection was dropped or
  // truncated. Surface it instead of reporting a phantom success.
  if (!sawTerminal) {
    handlers.onError('stream ended unexpectedly (no terminal frame)');
  }
}

export interface ResumeInterruptRequest {
  // The COMPOSITE thread_id echoed in the `interrupt` frame — sent back verbatim.
  thread_id: string;
  decision: 'approve' | 'edit' | 'reject';
  edited_action?: { name: string; args: Record<string, unknown> };
  message?: string;
  // The cart fingerprint the shopper saw on the approval card (from the interrupt's
  // action.args.cart_version). Echoed back so the server can reject an approval whose
  // cart changed since the card was shown (binds the approval to that exact quote).
  cart_version?: string;
}

/**
 * POST /api/interrupts/resume as a streaming fetch — resumes a paused
 * (interrupted) checkout turn with the shopper's decision. Streams SSE exactly
 * like /chat and is consumed via the same shared SSE consumer + handlers shape.
 */
export async function streamResumeInterrupt(
  req: ResumeInterruptRequest,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/interrupts/resume`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...authHeaders(),
      },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    handlers.onError(err instanceof Error ? err.message : 'network error');
    return;
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.detail) detail = String(body.detail);
    } catch {
      /* empty */
    }
    handlers.onError(detail);
    return;
  }

  if (!res.body) {
    handlers.onError('empty response body');
    return;
  }

  await consumeSSEStream(res, handlers);
}

export interface FeedbackRequest {
  run_id: string;
  // 1 = 👍, 0 = 👎. The backend stores a float score.
  score: number;
  comment?: string;
  user_id: string;
}

/**
 * POST /api/feedback: persists a thumbs rating (and optional comment) for a
 * turn, keyed by the turn's correlation id (`run_id`). The backend writes it
 * to the `feedback` collection in MongoDB.
 */
export async function submitFeedback(req: FeedbackRequest): Promise<void> {
  const res = await fetch(`${API_BASE}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.detail) detail = String(body.detail);
    } catch {
      /* empty */
    }
    throw new Error(detail);
  }
}
