/** Synthetic green-screen reference and resumable image generation.
 * The speaking clip is keyed to alpha locally and laid over unedited property
 * imagery on the narration clock. Gallery cuts never restart the presenter.
 */
import type { GalleryAsset } from "./property-cinematic";
import type { PropJobInput } from "./property-presentation";
import { type RequestHandle } from "./property-models";

export const PRESENTER_MODEL = {
  id: "higgsfield-ai/soul/v2/standard",
  endpoint: "higgsfield-ai/soul/v2/standard",
  url: "https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard",
  docs: "https://open.higgsfield.ai/models/higgsfield-ai/soul/v2/standard/api-reference",
} as const;

/** Visible disclosure rendered on presenter-mode videos. Never removed. */
export function presenterDisclosure(language: "fr" | "ar" | "en"): string {
  if (language === "ar") return "مقدّم مولّد بالذكاء الاصطناعي";
  if (language === "en") return "AI-generated presenter";
  return "Présentateur généré par IA";
}

/** Synthetic presenter reference: the identity used across every scene. */
export function presenterReferencePrompt(language: string = "fr"): string {
  void language; // prompt is language-independent; identity kept consistent
  return [
    "A photorealistic single person, a synthetic male Moroccan presenter and professional real estate agent, approximately 35-45 years old.",
    "Waist-up with complete shoulders, arms and hands inside the frame. Navy blazer, crisp white shirt, open collar, no tie.",
    "Short dark hair, well-groomed, warm confident smile, direct eye contact with camera.",
    "Natural skin texture with subtle imperfections, professional lighting with soft key light.",
    "Perfectly uniform flat saturated chroma-key green background, RGB 0 255 0, edge to edge. No scenery, shadows, gradients, texture, green clothing or green accessories. Camera locked off. Mouth unobstructed and face forward.",
    "MANDATORY: The entire background must be exactly RGB(0, 255, 0) pure green. No other colors in background.",
    "Approachable, trustworthy, knowledgeable expression - like a top real estate professional.",
    "Sharp focus on face and eyes, 85mm lens portrait aesthetic, high detail, 8K quality.",
  ].join(" ");
}

/**
 * Scene-prep prompt: edit the presenter into the actual listing photo.
 * MUST keep the photo (and any agency watermarks) intact.
 */
/** @deprecated Not used by the transparent presenter pipeline. */
export function scenePrepPrompt(input: PropJobInput): string {
  const kind = /villa|دار/i.test(input.listing.title) ? "villa" : "property";
  return [
    `Edit this exact property photo: add a photorealistic male presenter standing beside the ${kind},`,
    "waist-up visible, Moroccan man in a navy blazer over a white shirt, natural confident posture,",
    "matching the scene's existing light direction, shadows and color grading so he blends in realistically.",
    "Preserve the property exactly as shown: architecture, furniture, pool, garden, materials,",
    "and any existing watermarks or agency logos must remain untouched and clearly readable.",
    "Do not add or remove rooms, objects or views. No text overlays. Photorealistic editorial result.",
  ].join(" ");
}

/** Payload for the soul/v2 image-to-image request. imageUrl must be public HTTPS. */
/** @deprecated Not used: Soul Standard is text-to-image, not a scene editor. */
export function presenterSceneRequest(imageUrl: string, prompt: string) {
  if (!/^https:\/\/[^/]/.test(imageUrl)) throw new Error("Scene reference image must be a public https URL");
  return { image_url: imageUrl, prompt, strength: 0.45, quality: "high" };
}

/** Payload for the soul/v2 text-to-image reference portrait. */
export function presenterReferenceRequest(prompt: string) {
  return { prompt, aspect_ratio: "9:16", resolution: "1080p", batch_size: 1, enhance_prompt: false };
}

export type ComposeMode = "panel" | "presenter";
export function validatePresenterMode(value: unknown): ComposeMode {
  if (value === undefined || value === null || value === "" || value === "panel") return "panel";
  if (value === "presenter") return "presenter";
  throw new Error("Unknown compose mode — expected 'panel' or 'presenter'");
}

/**
 * Alternate presenter scenes with property-only shots for the composition.
 * Every presenter scene is used; property shots fill the gaps. With no scenes
 * the property photos are returned unchanged (panel mode stays untouched).
 */
export function planPresenterShots(photos: string[], avatarUrls: string[]): GalleryAsset[] {
  // Presenter playback belongs to the narration timeline, never the gallery timeline.
  // Gallery video paths are property motion clips only; preserve all source photos.
  void avatarUrls;
  return photos.map(photo => ({ photo }));
}

/**
 * Soul/v2 image-to-image generation with the same resumable request-handle
 * discipline as video: the handle is persisted by the caller (onSubmitted)
 * before polling, and a retry polls the saved handle instead of re-POSTing —
 * never silently submit a duplicate billable request.
 */
export async function generateSoulImage(opts: {
  input: object; keyId: string; keySecret: string;
  resume?: RequestHandle; onSubmitted?: (handle: RequestHandle) => void;
  log?: (msg: string) => void; wait?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<{ requestId: string; imageUrl: string }> {
  const API = "https://api.higgsfield.ai";
  const doFetch = opts.fetchImpl || fetch;
  const auth = `Key ${opts.keyId}:${opts.keySecret}`;
  const headers = { Authorization: auth, "Content-Type": "application/json" };
  let handle = opts.resume;
  if (!handle) {
    // A failed/ambiguous POST is never auto-retried: it could create a duplicate paid job.
    const response = await doFetch(`${API}/${PRESENTER_MODEL.endpoint}`, {
      method: "POST", headers, body: JSON.stringify(opts.input),
      signal: AbortSignal.timeout(60000), redirect: "error",
    } as RequestInit);
    const body = await response.json();
    if (!response.ok) throw new Error(`Higgsfield scene submission failed (${response.status})`);
    if (typeof body.request_id !== "string" || !body.request_id || typeof body.status_url !== "string") {
      throw new Error("Higgsfield returned no request handle");
    }
    const statusUrl = new URL(body.status_url);
    if (statusUrl.origin !== API) throw new Error("Unexpected provider status URL");
    handle = { requestId: body.request_id, statusUrl: statusUrl.href };
    (opts.onSubmitted || (() => {}))(handle);
  }
  const statusUrl = new URL(handle.statusUrl);
  if (statusUrl.origin !== API || statusUrl.username || statusUrl.password) throw new Error("Unexpected provider status URL");
  const wait = opts.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = Date.now() + 10 * 60 * 1000;
  let delay = 1200;
  while (Date.now() < deadline) {
    await wait(delay); delay = Math.min(8000, delay * 1.5);
    let response: Response;
    try { response = await doFetch(handle.statusUrl, { headers, signal: AbortSignal.timeout(30000), redirect: "error" } as RequestInit); }
    catch { continue; }
    if (response.status === 401 || response.status === 403) throw new Error("Higgsfield credentials rejected");
    if (!response.ok) { if (response.status >= 500 || response.status === 429) continue; throw new Error(`Higgsfield polling failed (${response.status})`); }
    const body = await response.json();
    opts.log?.(`${handle.requestId}: ${body.status}`);
    if (["failed", "nsfw", "canceled", "cancelled"].includes(body.status)) {
      throw new Error(`Higgsfield ${handle.requestId}: ${body.status}. Create a new job to submit a new request.`);
    }
    if (body.status === "completed") {
      const imageUrl = body.image?.url || body.output?.image?.url || body.images?.[0]?.url;
      if (typeof imageUrl !== "string" || !imageUrl.startsWith("https://")) throw new Error("Provider completed without an HTTPS image URL");
      return { requestId: handle.requestId, imageUrl };
    }
  }
  throw new Error(`Higgsfield timed out; request ${handle.requestId} is saved for retry`);
}
