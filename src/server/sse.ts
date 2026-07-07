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
  },
): AsyncGenerator<string> {
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
          if (opts.emitPlanFrames) {
            plan.todos.push({ id: String(plan.todos.length + 1), text: name, status: 'in_progress' });
            yield serializeFrame('plan', planSnapshot(plan));
          }
          break;
        }
        case 'tool-result': {
          const name = field<string>(part, 'toolName') ?? field<string>(part, 'name') ?? 'tool';
          yield serializeFrame('status', JSON.stringify({ phase: 'tool_end', name }));
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
