// Thin client for the Oinkalytics API (see docs/API.md). Shapes mirror api/schemas.py.

export type Explanation = { text: string; source: "llm" | "template" };

export type PenStatus = {
  pen_id: string;
  level: "calm" | "watch" | "alert";
  window: number;
  distressed: number;
  last_prediction_id: string | null;
  updated_at: string | null;
  summary: string;
};

export type Alert = {
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
};

export type Prediction = {
  prediction_id: string;
  pen_id: string | null;
  status: "calm" | "distressed" | "unsure";
  abstain_reason: "low_confidence" | "not_pig" | null;
  valence: { p_distressed: number; confidence: number };
  explanation: Explanation;
  audio_url: string;
};

/** Trend 1: this pen's recent distress share against its normal (GET /trends/pens/{id}). */
export type PenTrend = {
  pen_id: string;
  recent_calls: number;
  recent_share: number | null;
  normal_calls: number;
  normal_share: number | null;
  normal_source: "pen" | "barn" | null;
  ratio: number | null;
  summary: string;
};

/** Trend 2: a pen with the most distress in the barn several periods in a row. */
export type TrendEvent = {
  event_id: string;
  kind: "persistent";
  pen_id: string;
  created_at: string;
  message: string;
};

export type Ranking = { periods: number; period_label: string; flagged: string[]; message: string };

export type Oink = ReturnType<typeof oinkClient>;

export function oinkClient(base: string, fetchImpl: typeof fetch = fetch) {
  const url = (path: string) => `${base.replace(/\/$/, "")}${path}`;

  async function get(path: string): Promise<Response> {
    const res = await fetchImpl(url(path), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok && res.status !== 404) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return res;
  }

  return {
    async pens(): Promise<PenStatus[]> {
      return (await get("/pens")).json();
    },
    /** Alerts newer than `after`, oldest first; all of them when `after` is omitted. */
    async alerts(after?: string): Promise<Alert[]> {
      return (await get(`/alerts${after ? `?after=${encodeURIComponent(after)}` : ""}`)).json();
    },
    /** Latest alert, or undefined if none has fired yet. */
    async latestAlert(penId?: string): Promise<Alert | undefined> {
      const res = await get(`/alerts/latest${penId ? `?pen_id=${encodeURIComponent(penId)}` : ""}`);
      return res.status === 404 ? undefined : res.json();
    },
    /** WAV bytes for an `audio_url` like "/audio/clip_…". */
    async audio(audioUrl: string): Promise<Buffer> {
      const res = await get(audioUrl);
      if (res.status === 404) throw new Error(`audio not found: ${audioUrl}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async penTrend(penId: string): Promise<PenTrend | undefined> {
      const res = await get(`/trends/pens/${encodeURIComponent(penId)}`);
      return res.status === 404 ? undefined : res.json();
    },
    /** Trend events newer than `after`, oldest first; all of them when `after` is omitted. */
    async trendEvents(after?: string): Promise<TrendEvent[]> {
      return (await get(`/trends/events${after ? `?after=${encodeURIComponent(after)}` : ""}`)).json();
    },
    async ranking(periods = 3): Promise<Ranking> {
      return (await get(`/trends/ranking?periods=${periods}`)).json();
    },
    async predict(bytes: Buffer, filename: string, penId?: string): Promise<Prediction> {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)]), filename);
      if (penId) form.append("pen_id", penId);
      const res = await fetchImpl(url("/predict"), {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`POST /predict: HTTP ${res.status}`);
      return res.json();
    },
  };
}
