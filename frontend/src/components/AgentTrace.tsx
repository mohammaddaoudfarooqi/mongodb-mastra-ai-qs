import React, { useState } from 'react';
import type { TraceEvent } from '../api/client';

/* ── AgentTrace: the in-chat "watch it work" panel ───────────────────────────
 * Renders, per assistant turn, a legible timeline of the tools the agent ran —
 * the knowledge searches and the live MongoDB queries — each expandable to the
 * ACTUAL query args and returned documents. This is the credibility layer: it
 * shows the real MongoDB work behind the answer, in the same chat window.
 *
 * Trace steps arrive as separate `start` (args) and `end` (summary + result)
 * frames correlated by `id`; we merge them into one row per call. */

interface TraceRow {
  id: string;
  tool: string;
  args?: unknown;
  summary?: string;
  result?: unknown;
  done: boolean;
}

/** Per-tool icon for the curated line. */
function toolIcon(tool: string): string {
  if (tool === 'dataQuery') return '🗄️';
  if (tool === 'knowledgeSearch') return '🔍';
  if (tool.startsWith('cart')) return '🛒';
  if (tool === 'applyCoupon') return '🏷️';
  if (tool === 'checkout') return '✅';
  return '⚙️';
}

/** Compact MQL filter → human phrase, e.g. {price:{$lt:50}} → `price < 50`. */
function humanFilter(filter: unknown): string {
  if (!filter || typeof filter !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(filter as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ops = v as Record<string, unknown>;
      const opMap: Record<string, string> = { $lt: '<', $lte: '≤', $gt: '>', $gte: '≥', $ne: '≠', $eq: '=' };
      const opKey = Object.keys(ops)[0];
      if (opKey && opMap[opKey]) { parts.push(`${k} ${opMap[opKey]} ${JSON.stringify(ops[opKey])}`); continue; }
    }
    parts.push(`${k} = ${JSON.stringify(v)}`);
  }
  return parts.join(', ');
}

/**
 * The human-readable one-line summary of a trace step. Exported for unit testing
 * and so the row header and any collapsed view stay in sync.
 */
export function curatedLine(step: TraceEvent | TraceRow): string {
  const { tool, summary } = step;
  const args = step.args as Record<string, unknown> | undefined;
  if (tool === 'dataQuery' && args && typeof args.collection === 'string') {
    const where = humanFilter(args.filter);
    const base = `Queried ${args.collection}${where ? ` where ${where}` : ''}`;
    return summary ? `${base} → ${summary}` : base;
  }
  if (tool === 'knowledgeSearch') {
    return `Searched knowledge base${summary ? ` → ${summary}` : ''}`;
  }
  if (tool.startsWith('cart') || tool === 'applyCoupon' || tool === 'checkout') {
    return summary || tool;
  }
  return summary ? `${tool} → ${summary}` : tool;
}

function mergeRows(steps: TraceEvent[]): TraceRow[] {
  const byId = new Map<string, TraceRow>();
  const order: string[] = [];
  let synth = 0;
  for (const s of steps) {
    const id = s.id ?? `synth-${synth++}`;
    let row = byId.get(id);
    if (!row) { row = { id, tool: s.tool, done: false }; byId.set(id, row); order.push(id); }
    if (s.tool) row.tool = s.tool;
    if (s.phase === 'start') { if (s.args !== undefined) row.args = s.args; }
    else { row.done = true; if (s.summary !== undefined) row.summary = s.summary; if (s.result !== undefined) row.result = s.result; }
  }
  return order.map((id) => byId.get(id)!);
}

function pretty(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function TraceRowView({ row }: { row: TraceRow }) {
  const [open, setOpen] = useState(false);
  const hasRaw = row.args !== undefined || row.result !== undefined;
  return (
    <li style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span aria-hidden="true" style={{ flexShrink: 0 }}>{toolIcon(row.tool)}</span>
        <span style={{ lineHeight: 1.45, opacity: row.done ? 1 : 0.7 }}>{curatedLine(row)}</span>
        {hasRaw && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{
              marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 10,
              textTransform: 'uppercase', letterSpacing: '0.5px', flexShrink: 0,
            }}
          >
            {open ? 'hide query ▾' : 'show query ▸'}
          </button>
        )}
      </div>
      {open && hasRaw && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 24 }}>
          {row.args !== undefined && (
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '0.5px' }}>Query</div>
              <pre style={preStyle}>{pretty(row.args)}</pre>
            </div>
          )}
          {row.result !== undefined && (
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '0.5px' }}>Result from MongoDB</div>
              <pre style={preStyle}>{pretty(row.result)}</pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

const preStyle: React.CSSProperties = {
  margin: 0, padding: '6px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.25)',
  color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.4,
  maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
};

export default function AgentTrace({ steps }: { steps: TraceEvent[] }) {
  const [open, setOpen] = useState(true);
  const rows = mergeRows(steps);
  if (rows.length === 0) return null;
  const done = rows.filter((r) => r.done).length;
  return (
    <div style={{ borderTop: '1px solid var(--border)', background: 'rgba(0,237,100,0.03)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 14px', background: 'transparent', border: 'none', cursor: 'pointer',
          fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase',
          letterSpacing: '1px', color: 'var(--text-secondary)',
        }}
      >
        <span>How the agent worked · {done}/{rows.length} steps</span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul style={{ listStyle: 'none', margin: 0, padding: '0 14px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((r) => <TraceRowView key={r.id} row={r} />)}
        </ul>
      )}
    </div>
  );
}
