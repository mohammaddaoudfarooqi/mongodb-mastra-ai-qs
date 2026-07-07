const ROLE_TO_TYPE: Record<string, string> = { user: 'human', assistant: 'ai', tool: 'tool', system: 'system' };

function flattenContent(content: unknown): string {
  if (typeof content !== 'string') return stringifyParts(content);
  // Mastra stores object content as a JSON string; try to parse and flatten.
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'string') return parsed;
    return stringifyParts(parsed);
  } catch {
    return content; // genuine plain string
  }
}

function stringifyParts(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  const parts = (v as any).parts ?? (v as any).content;
  if (Array.isArray(parts)) {
    return parts.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  }
  if (typeof (v as any).text === 'string') return (v as any).text;
  return '';
}

export function projectMessage(m: { role: string; content: unknown }): { type: string; content: string } {
  return { type: ROLE_TO_TYPE[m.role] ?? m.role, content: flattenContent(m.content) };
}
