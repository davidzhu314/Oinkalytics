/** Mirrors api/schemas.py. The contract is frozen at hour 12: add fields, never rename. */

export type Status = "calm" | "distressed" | "unsure";
export type AbstainReason = "low_confidence" | "not_pig";
export type PenLevel = "calm" | "watch" | "alert";

export interface Valence {
  p_distressed: number;
  confidence: number;
}

export interface ContextGuess {
  label: string;
  p: number;
}

export interface Features {
  duration_s: number;
  f0_mean_hz: number | null;
  loudness_db: number;
  spectral_centroid_hz: number;
  am_rate_hz: number | null;
}

export interface SimilarCall {
  clip_id: string;
  status: "calm" | "distressed";
  context: string;
  similarity: number;
  audio_url: string;
}

export interface Explanation {
  text: string;
  source: "llm" | "template";
}

export interface Prediction {
  prediction_id: string;
  clip_id: string;
  pen_id: string | null;
  created_at: string;
  status: Status;
  abstain_reason: AbstainReason | null;
  valence: Valence;
  context_top3: ContextGuess[];
  features: Features;
  similar_calls: SimilarCall[];
  explanation: Explanation;
  audio_url: string;
}

export interface PenStatus {
  pen_id: string;
  level: PenLevel;
  window: number;
  distressed: number;
  last_prediction_id: string | null;
  updated_at: string | null;
  summary: string;
}

export interface Alert {
  alert_id: string;
  pen_id: string;
  created_at: string;
  message: string;
  distressed: number;
  window: number;
  confidence: number;
  trigger_prediction_id: string;
  explanation: Explanation;
  audio_url: string;
}

export interface Health {
  ok: boolean;
  mode: "mock" | "real";
  model: string;
}
