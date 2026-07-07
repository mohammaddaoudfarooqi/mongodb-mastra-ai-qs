export interface TurnSignals {
  knowledgeSearchRan: boolean;
  knowledgeSearchHadResults: boolean;
  dataQueryRan: boolean;
  mutatingToolRan: boolean;
}

/** Cache is attempted only on a conversation opener (no prior messages in the thread). */
export function isReadEligible(priorMessageCount: number): boolean {
  return priorMessageCount === 0;
}

/**
 * A miss is cached only when the answer was grounded in knowledgeSearch results
 * AND no dynamic (dataQuery) or side-effecting tool ran during the turn.
 */
export function isWriteEligible(s: TurnSignals): boolean {
  return s.knowledgeSearchRan && s.knowledgeSearchHadResults && !s.dataQueryRan && !s.mutatingToolRan;
}

/**
 * Recognize an apology / "couldn't retrieve" answer so it is NEVER written to the response
 * cache. Even a write-eligible turn (knowledgeSearch ran with hits) can produce a hedge if
 * the model fumbles the grounding — and once cached, that hedge is replayed to every future
 * opener with the same wording (this is exactly how the demo's hero prompts got poisoned).
 * A false positive only costs one un-cached (recomputed) answer; a false negative poisons the
 * cache, so this errs toward NOT caching. Matches near the START of the answer, where these
 * phrases occur, to avoid tripping on a legitimate answer that merely quotes an apology.
 */
export function isHedge(answer: string): boolean {
  const head = answer.slice(0, 300).toLowerCase();
  // `i(?:'m| am)?` matches "I", "I'm", or "I am" uniformly; then the hedge verb phrase.
  return (
    /\bi(?:'m| am)?\s+(?:sorry|apologi[sz]e)/.test(head) ||
    /\bi(?:'m| am)?\s+(?:can(?:'|no)t|couldn'?t|was(?:n'?t| not)?\s+able|unable|not able|having trouble|not finding)\b/.test(head) ||
    /(?:^|\W)(?:unable to (?:find|locate|retrieve)|couldn'?t (?:find|locate|retrieve))\b/.test(head)
  );
}

export function expiresAt(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}

/**
 * Returns the longest prefix of `str` whose UTF-8 byte length is <= `maxBytes`,
 * WITHOUT splitting a multi-byte character. Returns `str` unchanged if it already fits.
 */
export function capToBytes(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;

  // Walk back from maxBytes to find the start of the last complete UTF-8 code point.
  // UTF-8 continuation bytes match 0b10xxxxxx, i.e. (byte & 0xC0) === 0x80.
  let boundary = maxBytes;
  while (boundary > 0 && (buf[boundary] & 0xC0) === 0x80) {
    boundary--;
  }

  return buf.subarray(0, boundary).toString('utf8');
}
