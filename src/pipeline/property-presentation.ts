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
 * duration(2-15) + resolution. That is the audio-driven avatar
 * endpoint used. No other lip-sync model is claimed.
 */
import * as fs from "fs";
import { generateHiggsfield, type RequestHandle } from "./property-models";
import * as path from "path";
import { execFileSync } from "child_process";

export const HF_API = "https://api.higgsfield.ai";
export const ELEVEN_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

export type PropStage = "extract" | "script" | "voice" | "presenter" | "scenePrep" | "motion" | "lipsync" | "compose" | "render";
export const PROP_STAGES: PropStage[] = ["extract", "script", "voice", "presenter", "lipsync", "scenePrep", "motion", "compose", "render"];

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
  editStyle?: import("./property-cinematic").EditStyle;
  motionModel?: import("./property-models").PropertyMotion;
  mode?: import("./property-presenter").ComposeMode; // default 'panel'
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
    segments.push(cur.join(" "));
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

// ─── Higgsfield avatar; verified audio_url schema, 1080p ──────────
export interface HfPollResult { requestId: string; videoUrl: string; }
export async function hfAvatarSegment(opts: {
  keyId: string; keySecret: string; imageUrl: string; audioUrl: string;
  prompt: string; durationSec: number; aspectRatio: "9:16";
  resume?: RequestHandle; onSubmitted?: (handle: RequestHandle) => void;
  log?: (msg: string) => void;
}): Promise<HfPollResult> {
  if (!Number.isFinite(opts.durationSec) || opts.durationSec > 15) throw new Error("Narration segment exceeds the 15s avatar limit");
  return generateHiggsfield({
    endpoint: "wan/v2.7/image-to-video", keyId: opts.keyId, keySecret: opts.keySecret,
    resume: opts.resume, onSubmitted: opts.onSubmitted || (() => {}), log: opts.log,
    input: { image_url: opts.imageUrl, audio_url: opts.audioUrl, prompt: opts.prompt,
      duration: Math.max(2, Math.ceil(opts.durationSec)), resolution: "1080p", prompt_extend: false },
  });
}

// Live prices depend on model, resolution and account; never quote an unsupported estimate.
export function estimateCost(_totalSec: number) {
  return { elevenLabsUsd: "Check provider billing", higgsfieldUsd: "Check provider billing",
    note: "Prices vary by model, resolution and account. Confirm current provider billing before generating." };
}
