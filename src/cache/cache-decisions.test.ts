import { describe, it, expect } from 'vitest';
import { isReadEligible, isWriteEligible, isHedge, expiresAt, capToBytes, type TurnSignals } from './cache-decisions';

const grounded: TurnSignals = {
  knowledgeSearchRan: true, knowledgeSearchHadResults: true, dataQueryRan: false, mutatingToolRan: false,
};

describe('cache decisions', () => {
  it('read is eligible only on a fresh conversation (0 prior messages)', () => {
    expect(isReadEligible(0)).toBe(true);
    expect(isReadEligible(1)).toBe(false);
  });

  it('write is eligible only when grounded by knowledgeSearch results', () => {
    expect(isWriteEligible(grounded)).toBe(true);
    expect(isWriteEligible({ ...grounded, knowledgeSearchRan: false })).toBe(false);
    expect(isWriteEligible({ ...grounded, knowledgeSearchHadResults: false })).toBe(false);
  });

  it('write is blocked when dataQuery ran (dynamic price/stock must not be cached)', () => {
    expect(isWriteEligible({ ...grounded, dataQueryRan: true })).toBe(false);
  });

  it('write is blocked when a mutating tool ran', () => {
    expect(isWriteEligible({ ...grounded, mutatingToolRan: true })).toBe(false);
  });

  describe('isHedge (anti-poison guard)', () => {
    it('flags apology / could-not-retrieve answers (never cache these)', () => {
      for (const a of [
        "I apologize—I wasn't able to locate a summer sale pamphlet in the knowledge base.",
        "I'm sorry, I couldn't find that recipe.",
        "I apologize — I'm not finding detailed information about our loyalty program.",
        "I'm having trouble retrieving the recipe right now.",
        "Unable to locate the pamphlet you asked about.",
        "I'm unable to find that information.",
      ]) {
        expect(isHedge(a)).toBe(true);
      }
    });

    it('does NOT flag a real grounded answer', () => {
      for (const a of [
        'Return Policy\n# Return Policy\nMost items can be returned within 30 days.',
        "Here's what the Summer Sale Pamphlet is promoting: up to 30% off outdoor and kitchen.",
        'Members earn 1 point per dollar spent; 100 points = $5 in rewards.',
        'Recipe: 20-Minute Garlic Butter Pasta. Cook 400 g of spaghetti until al dente.',
      ]) {
        expect(isHedge(a)).toBe(false);
      }
    });
  });

  it('expiresAt adds ttlDays to now', () => {
    const now = new Date('2026-07-04T00:00:00.000Z');
    expect(expiresAt(now, 1).toISOString()).toBe('2026-07-05T00:00:00.000Z');
  });

  describe('capToBytes', () => {
    it('returns ASCII string unchanged when under cap', () => {
      const str = 'Hello, world!';
      expect(capToBytes(str, 100)).toBe(str);
      expect(capToBytes(str, Buffer.byteLength(str, 'utf8'))).toBe(str);
    });

    it('caps multi-byte emoji string on char boundary without corruption', () => {
      const emoji = '😀'; // 4 UTF-8 bytes per emoji
      const str = emoji.repeat(10); // 40 bytes total

      // Cap at 18 bytes — falls mid-character (4 complete emojis = 16 bytes, 5th starts at 16)
      const result = capToBytes(str, 18);

      // Must not contain replacement char
      expect(result).not.toContain('�');
      // Must be valid UTF-8 (no corruption)
      expect(result).toMatch(/^[\u{0}-\u{10FFFF}]*$/u);
      // Byte length must not exceed cap
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(18);
      // Must be a prefix of original (4 complete emojis = 16 bytes)
      expect(result).toBe(emoji.repeat(4));
      expect(Buffer.byteLength(result, 'utf8')).toBe(16);
    });

    it('caps CJK string on char boundary', () => {
      const str = '你好世界'; // each char is 3 UTF-8 bytes, total 12 bytes

      // Cap at 7 bytes — falls mid-character (2 complete = 6 bytes)
      const result = capToBytes(str, 7);

      expect(result).not.toContain('�');
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(7);
      expect(result).toBe('你好'); // 6 bytes
    });

    it('returns whole-char prefix when cap lands exactly on boundary', () => {
      const emoji = '😀';
      const str = emoji.repeat(5); // 20 bytes

      // Cap at exactly 12 bytes (3 complete emojis)
      const result = capToBytes(str, 12);

      expect(result).toBe(emoji.repeat(3));
      expect(Buffer.byteLength(result, 'utf8')).toBe(12);
    });

    it('returns empty string when cap is zero', () => {
      expect(capToBytes('abc', 0)).toBe('');
      expect(capToBytes('😀', 0)).toBe('');
    });
  });
});
