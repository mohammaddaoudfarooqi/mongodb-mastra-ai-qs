type Fields = Record<string, unknown>;

const counters = new Map<string, number>();

function emit(level: 'info' | 'warn' | 'error', msg: string, fields?: Fields) {
  const line = JSON.stringify({ ...(fields ?? {}), ts: new Date().toISOString(), level, msg });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
  counter: (name: string, delta = 1) => counters.set(name, (counters.get(name) ?? 0) + delta),
  snapshot: (): Record<string, number> => Object.fromEntries(counters),
};
