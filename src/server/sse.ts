export type StreamPart = { type: string; [k: string]: any };

/**
 * Read a field off a Mastra fullStream part. Mastra nests the real data under a
 * `payload` object (`{ type, runId, from, payload: { text | toolName | result | ... } }`),
 * while the flat AI-SDK v5 shape puts it at the top level. Prefer the nested value,
 * fall back to the flat one, so the adapter works against both shapes.
 */
export function field<T = any>(part: StreamPart, key: string): T | undefined {
  const payload = (part as any).payload;
  if (payload && key in payload) return payload[key];
  return (part as any)[key];
}

export interface PlanTodo { id: string; text: string; status: 'pending' | 'in_progress' | 'completed'; }
export interface PlanState { todos: PlanTodo[]; }

/**
 * Serialize an SSE frame the way sse_starlette does and the Cartsmith parser expects:
 * `event: <name>\n`, one `data: <segment>\n` per newline-split segment, then `\n`.
 */
export function serializeFrame(event: string, data: string): string {
  const dataLines = data.split('\n').map(seg => `data: ${seg}`).join('\n');
  return `event: ${event}\n${dataLines}\n\n`;
}

function planSnapshot(state: PlanState): string {
  return JSON.stringify({ todos: state.todos, updated_at: null });
}

const DEFAULT_TRACE_MAX_BYTES = 8192;
const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|authorization|connection[_-]?string|mongodb_uri)/i;

/**
 * Recursively redact secret-looking fields (by key name) from a trace payload so a
 * raw args/result peek can never leak a key or connection string into the chat UI.
 */
function scrubSecrets(value: any): any {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : scrubSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * Bound a trace payload so one oversize tool result (e.g. 25 full product docs) can
 * neither freeze the client nor blow the frame. If the scrubbed payload serializes
 * larger than `maxBytes`, replace it with a truncation marker carrying a byte count.
 */
function capPayload(value: any, maxBytes: number): any {
  const scrubbed = scrubSecrets(value);
  if (scrubbed === undefined) return undefined;
  const serialized = JSON.stringify(scrubbed);
  if (serialized !== undefined && serialized.length > maxBytes) {
    return { __truncated: true, bytes: serialized.length, preview: serialized.slice(0, 512) };
  }
  return scrubbed;
}

/**
 * Build a fully-capped, scrubbed `trace` frame JSON string from an out-of-band trace step
 * (see src/server/trace.ts). Used by the /chat handler to emit sub-agent tool steps that
 * never reach the tool-call/tool-result stream parts. Mirrors the inline trace frames so the
 * frontend sees one uniform shape.
 */
export function capTraceStep(
  step: { id: string; tool: string; args?: unknown; summary?: string; result?: unknown },
  maxBytes = DEFAULT_TRACE_MAX_BYTES,
): string {
  const hasArgs = step.args !== undefined;
  return serializeFrame('trace', JSON.stringify({
    id: step.id,
    phase: 'end',
    tool: step.tool,
    summary: step.summary,
    ...(hasArgs ? { args: capPayload(step.args, maxBytes) } : {}),
    result: capPayload(step.result, maxBytes),
    oob: true,
  }));
}

/** Compact human summary of a tool result for the curated trace line. */
function summarizeResult(tool: string, result: any): string {
  if (result && typeof result === 'object') {
    if (Array.isArray((result as any).rows)) return `${(result as any).rows.length} documents`;
    if (Array.isArray((result as any).hits)) return `${(result as any).hits.length} hits`;
    if ((result as any).ok === false && typeof (result as any).reason === 'string') return `rejected: ${(result as any).reason}`;
    if ((result as any).ok === true) return 'ok';
    if ((result as any).status) return String((result as any).status);
  }
  return tool;
}

/**
 * Transform a Mastra fullStream part iterable into Cartsmith SSE frame strings.
 * Guarantees correlation-first and exactly-one-terminal, even if `parts` throws.
 */
export async function* toCartsmithFrames(
  parts: AsyncIterable<StreamPart>,
  opts: {
    correlationId: string;
    emitPlanFrames?: boolean;
    /**
     * Optional trailer emitted ONLY on the successful `done` path, immediately
     * before the `done` terminal — never after an `error` terminal or a throw.
     * This is how a non-terminal `interrupt` frame is guaranteed to be followed
     * by `done` (INV-002): the checkout bridge passes a generator here instead of
     * string-sniffing this function's output to reorder frames.
     */
    beforeDone?: () => AsyncIterable<string>;
    /**
     * When the caller has ALREADY written the correlation frame (to give the client
     * instant feedback before the slow recall/cache/first-LLM work), set this so the
     * frame is not emitted twice. The correlation-first contract still holds — it is
     * just satisfied by the caller instead of here.
     */
    skipCorrelation?: boolean;
    /**
     * Reports which terminal frame was emitted: 'error' (from an `error` part OR a thrown
     * stream) or 'done' (success). The caller uses this to gate the response-cache write —
     * catching the THROW path, which an in-loop `error`-part flag alone would miss.
     */
    onTerminal?: (kind: 'done' | 'error') => void;
    /**
     * Max serialized bytes for a `trace` frame's args/result payload. Oversize
     * payloads are replaced with a truncation marker so one big tool result can
     * neither freeze the client nor blow the frame. Defaults to 8 KiB.
     */
    traceMaxBytes?: number;
  },
): AsyncGenerator<string> {
  const traceMaxBytes = opts.traceMaxBytes ?? DEFAULT_TRACE_MAX_BYTES;
  if (!opts.skipCorrelation) yield serializeFrame('correlation', opts.correlationId);
  const plan: PlanState = { todos: [] };
  let terminated = false;
  try {
    for await (const part of parts) {
      switch (part.type) {
        case 'text-delta': {
          const text = field<string>(part, 'text') ?? field<string>(part, 'delta') ?? '';
          if (text) yield serializeFrame('token', text);
          break;
        }
        case 'tool-call':
        case 'tool-call-start': {
          const name = field<string>(part, 'toolName') ?? field<string>(part, 'name') ?? 'tool';
          yield serializeFrame('status', JSON.stringify({ phase: 'tool_start', name }));
          // Rich trace frame (args) so the chat UI can show what the agent asked for
          // (e.g. the MQL filter). Additive: `status` above still drives the live pill.
          yield serializeFrame('trace', JSON.stringify({
            id: field<string>(part, 'toolCallId') ?? field<string>(part, 'id'),
            phase: 'start',
            tool: name,
            args: capPayload(field(part, 'args'), traceMaxBytes),
          }));
          if (opts.emitPlanFrames) {
            plan.todos.push({ id: String(plan.todos.length + 1), text: name, status: 'in_progress' });
            yield serializeFrame('plan', planSnapshot(plan));
          }
          break;
        }
        case 'tool-result': {
          const name = field<string>(part, 'toolName') ?? field<string>(part, 'name') ?? 'tool';
          yield serializeFrame('status', JSON.stringify({ phase: 'tool_end', name }));
          const result = field(part, 'result');
          yield serializeFrame('trace', JSON.stringify({
            id: field<string>(part, 'toolCallId') ?? field<string>(part, 'id'),
            phase: 'end',
            tool: name,
            summary: summarizeResult(name, result),
            result: capPayload(result, traceMaxBytes),
          }));
          if (opts.emitPlanFrames) {
            const todo = [...plan.todos].reverse().find(t => t.text === name && t.status === 'in_progress');
            if (todo) todo.status = 'completed';
            yield serializeFrame('plan', planSnapshot(plan));
          }
          break;
        }
        case 'error': {
          terminated = true;
          opts.onTerminal?.('error');
          yield serializeFrame('error', String(field(part, 'error') ?? field(part, 'message') ?? 'stream error'));
          return;
        }
        case 'finish':
        case 'finish-step':
          // handled after the loop by the single done terminal
          break;
        default:
          break; // ignore unknown parts (keepalives, step markers, etc.)
      }
    }
    // Successful completion: emit any trailer (e.g. a checkout `interrupt` frame)
    // before the single `done` terminal, so `done` always comes last.
    if (opts.beforeDone) {
      for await (const frame of opts.beforeDone()) yield frame;
    }
    terminated = true;
    opts.onTerminal?.('done');
    yield serializeFrame('done', '');
  } catch (err) {
    if (!terminated) {
      opts.onTerminal?.('error');
      yield serializeFrame('error', err instanceof Error ? err.message : 'stream error');
    }
  }
}
