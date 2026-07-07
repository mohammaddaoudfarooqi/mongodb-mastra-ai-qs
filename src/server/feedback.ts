export interface FeedbackRequest {
  run_id: string;
  score: number;
  comment?: string;
  user_id: string;
}

export interface FeedbackDoc {
  _id: string;
  run_id: string;
  user_id: string;
  score: number;
  comment: string | null;
  created_at: Date;
}

/** Build the feedback document persisted per turn, keyed by the turn's correlation id. */
export function buildFeedbackDoc(req: FeedbackRequest, now: Date): FeedbackDoc {
  return {
    _id: req.run_id,
    run_id: req.run_id,
    user_id: req.user_id,
    score: req.score,
    comment: req.comment ?? null,
    created_at: now,
  };
}
