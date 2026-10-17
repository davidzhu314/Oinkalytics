/**
 * Typed client for the Oinkalytics API (docs/API.md). The bot never does ML;
 * it only makes these calls. Works against the mock server unchanged.
 */

import { config } from "./config.ts";
import type { Alert, Health, PenStatus, Prediction } from "./types.ts";

export class ApiError extends Error {
  constructor(readonly status: number, readonly path: string, body: string) {
    super(`${path} -> ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "ApiError";
  }
}

/** Thrown when the API answers 404, which several endpoints use as "nothing yet". */
export class NotFoundError extends ApiError {}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${config.api}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw res.status === 404
      ? new NotFoundError(404, path, body)
      : new ApiError(res.status, path, body);
  }
  return (await res.json()) as T;
}

export const health = () => get<Health>("/health");
export const pens = () => get<PenStatus[]>("/pens");
export const pen = (penId: string) => get<PenStatus>(`/pens/${encodeURIComponent(penId)}`);
export const prediction = (id: string) => get<Prediction>(`/predictions/${encodeURIComponent(id)}`);

/** Alerts newer than `after`; all of them when `after` is undefined. */
export const alertsAfter = (after?: string) =>
  get<Alert[]>(`/alerts${after ? `?after=${encodeURIComponent(after)}` : ""}`);

/** Latest alert, or null when none has fired yet (the API answers 404). */
export async function latestAlert(penId?: string): Promise<Alert | null> {
  try {
    return await get<Alert>(`/alerts/latest${penId ? `?pen_id=${encodeURIComponent(penId)}` : ""}`);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

/** Download a clip. `audioUrl` is the relative path the API handed us. */
export async function audio(audioUrl: string): Promise<Buffer> {
  const res = await fetch(`${config.api}${audioUrl}`);
  if (!res.ok) throw new ApiError(res.status, audioUrl, await res.text().catch(() => ""));
  return Buffer.from(await res.arrayBuffer());
}

/** Send the farmer's own recording through the model. */
export async function predict(
  bytes: Buffer,
  filename: string,
  opts: { penId?: string; mockLabel?: string } = {},
): Promise<Prediction> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), filename);
  if (opts.penId) form.append("pen_id", opts.penId);
  if (opts.mockLabel) form.append("mock_label", opts.mockLabel);
  const res = await fetch(`${config.api}/predict`, { method: "POST", body: form });
  if (!res.ok) throw new ApiError(res.status, "/predict", await res.text().catch(() => ""));
  return (await res.json()) as Prediction;
}
