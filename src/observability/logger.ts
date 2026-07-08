type Fields = Record<string, unknown>;
type Level = 'info' | 'warn' | 'error';

const counters = new Map<string, number>();

/**
 * A structured log record. `ts` is a Date (not an ISO string) so the MongoDB TTL index on
 * `ts` can expire old docs; the console path serializes it to ISO for a readable line.
 */
export interface LogRecord { ts: Date; level: Level; msg: string; fields?: Fields; }

/**
 * A pluggable log sink. The Mongo sink (attachMongoLogSink) implements this; the logger
 * calls `write` for every record but never awaits it — a sink must be non-blocking and
 * fail-open (a logging failure must never break a request or throw into the caller).
 */
export interface LogSink { write: (rec: LogRecord) => void; }

let sink: LogSink | null = null;

/** Register the log sink (e.g. the MongoDB sink). A no-op replacement clears it. */
export function setLogSink(next: LogSink | null): void { sink = next; }

function emit(level: Level, msg: string, fields?: Fields) {
  const ts = new Date();
  // Console: single-line JSON (unchanged contract — ts as ISO string).
  const line = JSON.stringify({ ...(fields ?? {}), ts: ts.toISOString(), level, msg });
  if (level === 'error') console.error(line);
  else console.log(line);
  // Mirror to the attached sink (MongoDB) if present. Guard so a broken sink can never
  // throw into the hot path; the sink itself is also expected to swallow its own errors.
  if (sink) { try { sink.write({ ts, level, msg, fields }); } catch { /* logging must never throw */ } }
}

export const logger = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
  counter: (name: string, delta = 1) => counters.set(name, (counters.get(name) ?? 0) + delta),
  snapshot: (): Record<string, number> => Object.fromEntries(counters),
};
