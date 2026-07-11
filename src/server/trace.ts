// src/server/trace.ts
//
// Out-of-band per-turn agent trace collector for the in-chat "watch it work" panel.
//
// WHY out-of-band: the concierge's most valuable trace steps — the NL→MQL `dataQuery`
// and the cart writes — run inside the `dealsAndCart` SUB-AGENT. Mastra re-emits a
// sub-agent's inner tool activity on the parent stream as `subagent_tool_start` /
// `subagent_tool_end` events (verified against @mastra/core 1.50.0), NOT as first-class
// `tool-call` / `tool-result` parts, and the public fullStream ChunkType union exposes no
// `subagent-tool-*` chunk. So those steps never reach the `tool-call`/`tool-result` cases
// the SSE adapter (sse.ts) handles, and would be dropped.
//
// This collector is fed by the tools' own `execute` hooks (which fire regardless of how
// Mastra streams), so it is independent of Mastra's streaming internals and future-proof.
// The /chat handler drains it after the agent turn and emits the collected steps as the
// same `trace` SSE frames sse.ts already emits for the router-owned tools (knowledgeSearch,
// checkout), so the frontend sees one uniform trace stream.

/** A single tool step captured during a turn, in the same shape as the sse.ts `trace` frame. */
export interface TraceStep {
  /** Correlates start/end for the same tool call. Synthesized per step when Mastra hides it. */
  id: string;
  tool: string;
  /** The tool input (e.g. the MQL `{collection, filter}`). Capped + scrubbed at emit time. */
  args?: unknown;
  /** Compact human summary of the result ("8 documents", "added Trail Runner"). */
  summary?: string;
  /** The tool output (e.g. `{ok, rows}`). Capped + scrubbed at emit time. */
  result?: unknown;
}

/**
 * Per-turn sink the sub-agent tools push into. One instance is created per /chat turn and
 * attached to the TurnContext; tools call `.push(...)` from inside `execute`. The handler
 * calls `.drain()` after the agent stream completes to emit the steps.
 */
export class TraceSink {
  private steps: TraceStep[] = [];
  private seq = 0;

  /** Record a completed tool step. Returns nothing; never throws (best-effort). */
  push(step: Omit<TraceStep, 'id'> & { id?: string }): void {
    this.seq += 1;
    this.steps.push({ id: step.id ?? `oob-${this.seq}`, tool: step.tool, args: step.args, summary: step.summary, result: step.result });
  }

  /** Return the collected steps (in push order). */
  list(): TraceStep[] {
    return this.steps;
  }

  get size(): number {
    return this.steps.length;
  }
}
