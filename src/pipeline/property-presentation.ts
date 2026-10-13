/**
 * property-presentation.ts — Property URL -> Avatar presentation video job pipeline.
 *
 * Stages (tracked per job, resumable):
 *   extract   — SSRF-safe fetch + adapters -> listing.json (reviewed draft)
 *   script    — narration segments (45–60s total) from REVIEWED facts; user-edited
 *   voice     — ElevenLabs TTS per segment; ffprobe-measured durations
 *   avatar    — Higgsfield wan/v2.7/image-to-video per segment (image_url + audio_url,
 *               2–15s each, real request_id polling) -> lipsynced presenter clips
 *   compose   — Remotion composition: vertical 1080x1920, real property photos,
 *               avatar in small panel, captions; smooth transitions, pan/zoom
 *   render    — remotion render -> MP4
 *
 * Verified Higgsfield capability (docs.higgsfield.ai, checked in this repo's
 * research): wan/v2.7/image-to-video accepts image_url + audio_url + prompt +
 * duration(2-15) + resolution + aspect_ratio. That is the audio-driven avatar
 * endpoint used. No other lip-sync model is claimed.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

export const HF_API = "https://api.higgsfield.ai";
export const ELEVEN_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

export type PropStage = "extract" | "script" | "voice" | "avatar" | "compose" | "render";
export const PROP_STAGES: PropStage[] = ["extract", "script", "voice", "avatar", "compose", "render"];

export interface PropJobInput {
  sourceUrl: string;
  // Reviewed listing (defaults = extracted; user may edit any field)
  listing: {
    title: string;
    reference: string;
    location: string;
    price: number | null;
    priceCurrency: string | null;
    landAreaM2: number | null;
    builtAreaM2: number | null;
    bedrooms: number | null;
    bathrooms: number | null;
    description: string;
    amenities: string[];
    images: string[]; // ordered, selected subset of extracted (or uploaded data-URLs)
  };
  narration: string; // reviewed; segments derived from it
  language: "fr" | "ar" | "en";
  voiceId: string;
  avatarImageB64?: string; // uploaded portrait (data:...;base64 or raw base64)
  branding: {
    agencyName: string; // editable; defaults to the SOURCE agency, never Galiska
    contactLine: string;
  };
  clientToken?: string;
}

export const MAX_SEGMENT_SEC = 14; // Higgsfield wan/v2.7 duration max 15s; keep margin
export const TARGET_TOTAL_SEC: [number, number] = [45, 60];

export function segmentNarration(narration: string, maxSec = MAX_SEGMENT_SEC): string[] {
  const text = narration.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("Narration is empty");
  // ~2.6 words/sec for multilingual TTS at normal pace
  const wordsPerSegment = Math.floor(maxSec * 2.6);
  const words = text.split(" ");
  const segments: string[] = [];
  let cur: string[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= wordsPerSegment) { segments.push(cur.join(" ")); cur = []; }
  }
  if (cur.length) {
    if (cur.length < 4 && segments.length) segments[segments.length - 1] += " " + cur.join(" ");
    else segments.push(cur.join(" "));
  }
  return segments;
}

export function probeDuration(file: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const d = Number(out.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`Invalid audio duration for ${path.basename(file)}`);
  return d;
}

// ─── ElevenLabs TTS ───────────────────────────────────────────────
export async function elevenTtsSegment(text: string, voiceId: string, apiKey: string, outFile: string): Promise<string> {
  const res = await fetch(`${ELEVEN_TTS_URL}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${t.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 200) throw new Error("ElevenLabs returned empty audio");
  fs.writeFileSync(outFile, buf);
  return outFile;
}

// ─── Higgsfield avatar (verified endpoint only) ───────────────────
const TERMINAL = new Set(["completed", "failed", "nsfw", "canceled"]);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface HfPollResult { requestId: string; videoUrl: string; }

export async function hfAvatarSegment(opts: {
  keyId: string; keySecret: string;
  imageUrl: string; audioUrl: string; prompt: string; durationSec: number;
  aspectRatio: "9:16";
  log?: (msg: string) => void;
}): Promise<HfPollResult> {
  const auth = `Key ${opts.keyId}:${opts.keySecret}`;
  const submit = await fetch(`${HF_API}/wan/v2.7/image-to-video`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      image_url: opts.imageUrl,
      audio_url: opts.audioUrl,
      prompt: opts.prompt,
      duration: Math.min(Math.max(Math.round(opts.durationSec), 2), 15),
      resolution: "720p",
      aspect_ratio: opts.aspectRatio,
    }),
  });
  const body = await submit.json().catch(() => ({}));
  if (!submit.ok) throw new Error(`Higgsfield submit ${submit.status}: ${JSON.stringify(body).slice(0, 250)}`);
  const { request_id, status_url } = body as { request_id?: string; status_url?: string };
  if (!status_url || !request_id) throw new Error(`Higgsfield returned no request handle: ${JSON.stringify(body).slice(0, 200)}`);
  opts.log?.(`avatar request ${request_id} (${body.status})`);

  let delay = 2000, last = String(body.status || "queued");
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(delay); delay = Math.min(delay * 1.5, 10000);
    const poll = await fetch(status_url, { headers: { Authorization: auth } });
    if (poll.status === 401) throw new Error("Higgsfield polling: invalid credentials");
    if (!poll.ok) continue; // transient; retry
    const d = await poll.json();
    const status = String(d.status || "");
    if (status !== last) { opts.log?.(`avatar ${request_id}: ${status}`); last = status; }
    if (TERMINAL.has(status)) {
      if (status !== "completed") throw new Error(`Higgsfield ${request_id} ended ${status}: ${JSON.stringify(d.error || {}).slice(0, 200)}`);
      const videoUrl = d.video?.url || d.output?.video?.url;
      if (!videoUrl) throw new Error(`Higgsfield ${request_id}: completed without video URL`);
      return { requestId: request_id, videoUrl };
    }
  }
  throw new Error(`Higgsfield polling timeout for ${request_id}`);
}

// ─── Cost estimate (per docs pricing; approximate) ─────────────────
export function estimateCost(totalSec: number): { elevenLabsUsd: string; higgsfieldUsd: string; note: string } {
  // ElevenLabs multilingual v2: ~$0.15/1k chars typical tier -> ~45-60s narration ≈ 150-180 words ≈ 900-1100 chars
  const chars = Math.round(totalSec * 17); // ~17 chars/sec spoken
  // Higgsfield wan/v2.7/video: catalog listed from ~$0.027/s (60% off) to $0.068/s; use upper bound
  const hfUpper = totalSec * 0.068;
  return {
    elevenLabsUsd: `$${(chars / 1000 * 0.15).toFixed(2)}`,
    higgsfieldUsd: `$${hfUpper.toFixed(2)}`,
    note: "Approximate upper bounds; confirm current prices with the providers before generating.",
  };
}
