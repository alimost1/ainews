/** Verified request schemas: official Higgsfield API references, 2026-10-14. */
export const MOTION_MODELS = {
  'kling-3-pro': { label: 'Kling 3.0 Pro · cinematic', endpoint: 'kling-video/v3.0/pro/image-to-video', docs: 'https://open.higgsfield.ai/models/kling-video/v3.0/pro/image-to-video/api-reference' },
  'wan-3': { label: 'Wan 3.0 · 1080p', endpoint: 'alibaba/wan-3.0/image-to-video', docs: 'https://open.higgsfield.ai/models/alibaba/wan-3.0/image-to-video/api-reference' },
} as const;
export type MotionModel = keyof typeof MOTION_MODELS;
export type PropertyMotion = 'photo' | MotionModel;
export function validateMotion(value: unknown): PropertyMotion {
  if (value === undefined || value === 'photo') return 'photo';
  if (value === 'kling-3-pro' || value === 'wan-3') return value;
  throw new Error('Unknown property motion model');
}
export function motionRequest(model: MotionModel, imageUrl: string, index: number) {
  if (!MOTION_MODELS[model]) throw new Error('Unknown motion model');
  const movements = ['A slow controlled dolly forward', 'A gentle lateral slider move to the right', 'A subtle dolly backward revealing the existing composition', 'A gentle lateral slider move to the left'];
  const prompt = `${movements[index % movements.length]}. Professional real estate cinematography, stable camera, realistic subtle motion. Use this exact property photo as the first frame. Preserve the building geometry, rooms, furniture, pool, garden, materials and watermarks exactly as shown. No new rooms, objects, people, structural changes, aerial flight or invented views. No text overlays. Single continuous shot.`;
  const common = { image_url: imageUrl, prompt, duration: 5 };
  return model === 'kling-3-pro'
    ? { ...common, sound: 'off', cfg_scale: 0.5, multi_shots: false }
    : { ...common, resolution: '1080p', aspect_ratio: 'adaptive', generate_audio: false, enable_thinking: false };
}
const API = 'https://api.higgsfield.ai';
export interface RequestHandle { requestId: string; statusUrl: string }
function safeStatus(url: string) {
  const parsed = new URL(url);
  if (parsed.origin !== API || parsed.username || parsed.password) throw new Error('Unexpected provider status URL');
  return parsed.href;
}
/** Persist the returned handle before polling. Retrying a job polls it, never resubmits it. */
export async function generateHiggsfield(opts: {
  endpoint: string; input: object; keyId: string; keySecret: string;
  resume?: RequestHandle; onSubmitted: (handle: RequestHandle) => void;
  log?: (message: string) => void; wait?: (ms: number) => Promise<void>;
}) {
  const headers = { Authorization: `Key ${opts.keyId}:${opts.keySecret}`, 'Content-Type': 'application/json' };
  let handle = opts.resume;
  if (!handle) {
    // Do not automatically retry an ambiguous POST: it can create duplicate paid jobs.
    const response = await fetch(`${API}/${opts.endpoint}`, { method: 'POST', headers, body: JSON.stringify(opts.input), signal: AbortSignal.timeout(60000), redirect: 'error' });
    const body = await response.json();
    if (!response.ok) throw new Error(`Higgsfield submission failed (${response.status})`);
    if (typeof body.request_id !== 'string' || !body.request_id || typeof body.status_url !== 'string') throw new Error('Higgsfield returned no request handle');
    handle = { requestId: body.request_id, statusUrl: safeStatus(body.status_url) };
    opts.onSubmitted(handle);
  }
  safeStatus(handle.statusUrl);
  const wait = opts.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = Date.now() + 20 * 60 * 1000;
  let delay = 1500;
  while (Date.now() < deadline) {
    await wait(delay); delay = Math.min(10000, delay * 1.5);
    let response: Response;
    try { response = await fetch(handle.statusUrl, { headers, signal: AbortSignal.timeout(30000), redirect: 'error' }); }
    catch { continue; }
    if (response.status === 401 || response.status === 403) throw new Error('Higgsfield credentials rejected');
    if (!response.ok) { if (response.status >= 500 || response.status === 429) continue; throw new Error(`Higgsfield polling failed (${response.status})`); }
    const body = await response.json();
    opts.log?.(`${handle.requestId}: ${body.status}`);
    if (['failed', 'nsfw', 'canceled', 'cancelled'].includes(body.status)) throw new Error(`Higgsfield ${handle.requestId}: ${body.status}. Create a new job to submit a new request.`);
    if (body.status === 'completed') {
      const videoUrl = body.video?.url || body.output?.video?.url;
      if (typeof videoUrl !== 'string' || !videoUrl.startsWith('https://')) throw new Error('Provider completed without an HTTPS video URL');
      return { requestId: handle.requestId, videoUrl };
    }
  }
  throw new Error(`Higgsfield timed out; request ${handle.requestId} is saved for retry`);
}
