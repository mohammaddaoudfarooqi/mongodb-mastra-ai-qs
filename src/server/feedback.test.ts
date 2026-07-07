import { describe, it, expect } from 'vitest';
import { buildFeedbackDoc } from './feedback';

describe('buildFeedbackDoc', () => {
  const now = new Date('2026-07-04T12:00:00.000Z');

  it('keys the doc by run_id and carries the score, comment, user, and timestamp', () => {
    expect(buildFeedbackDoc({ run_id: 'turn-1', score: 1, comment: 'great', user_id: 'demo' }, now)).toEqual({
      _id: 'turn-1', run_id: 'turn-1', user_id: 'demo', score: 1, comment: 'great', created_at: now,
    });
  });

  it('defaults a missing comment to null', () => {
    expect(buildFeedbackDoc({ run_id: 'turn-2', score: 0, user_id: 'demo' }, now).comment).toBeNull();
  });
});
