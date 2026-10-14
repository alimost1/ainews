/**
 * property-api.ts — HTTP endpoints for the Property -> Avatar Presentation flow.
 *
 *   POST /api/property/extract     {url}          -> extracted listing (SSRF-safe)
 *   POST /api/property/jobs        draft+generate -> job id (clientToken idempotent)
 *   GET  /api/property/jobs                       -> history
 *   GET  /api/property/jobs/:id                   -> detail w/ stages
 *   POST /api/property/jobs/:id/generate          -> queue after review
 *   POST /api/property/jobs/:id/cancel
 *   GET  /api/property/jobs/:id/video             -> download MP4
 *   POST /api/property/upload-avatar              -> multipart/data-url portrait (2 MB max)
 *   GET  /api/property/config                    -> capabilities + cost estimate
 *
 * All provider keys stay server-side; responses never include them.
 */
import * as http from "http";
import { MOTION_MODELS, validateMotion } from "./property-models";
import * as fs from "fs";
import * as path from "path";
import { URL } from "url";
import { extractListing, downloadImageSafe } from "./property-extract";
import { estimateCost, segmentNarration, MAX_SEGMENT_SEC } from "./property-presentation";
import { PropJobStore, propJobDir, publicPropJob, PROP_JOBS_ROOT } from "./property-jobs";
import { submitPropJob, resumePropJobs, propQueueStats, propStore } from "./property-runner";

const store = new PropJobStore();
const MAX_JSON_BYTES = 512 * 1024;      // listing review payloads can carry narration text
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_DIR = path.join(PROP_JOBS_ROOT, "avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function propertyCapabilities() {
  const hfConfigured = !!(process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET);
  const elevenConfigured = !!process.env.ELEVENLABS_API_KEY;
  return {
    lipSync: {
      supported: hfConfigured,
      provider: "Higgsfield",
      model: "wan/v2.7/image-to-video",
      verifiedEndpoint: "POST https://api.higgsfield.ai/wan/v2.7/image-to-video",
      params: { image_url: "presenter portrait URL", audio_url: "segment narration URL", duration: "2-15s", resolution: "1080p" },
      missing: hfConfigured ? [] : ["HF_API_KEY_ID", "HF_API_KEY_SECRET"],
    },
    motion: { supported: hfConfigured, models: MOTION_MODELS, default: "photo" },
    tts: {
      supported: elevenConfigured,
      provider: "ElevenLabs",
      model: "eleven_multilingual_v2",
      defaultVoiceId: process.env.ELEVEN_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb",
      missing: elevenConfigured ? [] : ["ELEVENLABS_API_KEY"],
    },
    languages: [
      { code: "fr", label: "Français (défaut)", rtl: false },
      { code: "ar", label: "العربية", rtl: true },
      { code: "en", label: "English", rtl: false },
    ],
    video: { width: 1080, height: 1920, targetDurationSec: [45, 60], maxSegmentSec: MAX_SEGMENT_SEC },
  };
}

function validateDraft(body: any) {
  const listing = body?.listing;
  if (!listing || typeof listing !== "object") throw new Error("listing is required");
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const narration = str(body.narration, 6000);
  if (narration.length < 40) throw new Error("Narration too short (min 40 chars)");
  const language = ["fr", "ar", "en"].includes(body.language) ? body.language : "fr";
  const images = Array.isArray(listing.images)
    ? listing.images.filter((i: unknown) => typeof i === "string" && /^https?:\/\//.test(i) || typeof i === "string" && i.startsWith("uploaded:")).slice(0, 20)
    : [];
  return {
    motionModel: validateMotion(body.motionModel),
    sourceUrl: str(body.sourceUrl, 500) || "",
    language,
    voiceId: str(body.voiceId, 64) || (process.env.ELEVEN_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"),
    narration,
    listing: {
      title: str(listing.title, 300),
      reference: str(listing.reference, 60),
      location: str(listing.location, 200),
      price: num(listing.price),
      priceCurrency: str(listing.priceCurrency, 8) || null,
      landAreaM2: num(listing.landAreaM2),
      builtAreaM2: num(listing.builtAreaM2),
      bedrooms: num(listing.bedrooms),
      bathrooms: num(listing.bathrooms),
      description: str(listing.description, 4000),
      amenities: Array.isArray(listing.amenities) ? listing.amenities.filter((a: unknown) => typeof a === "string").map((a: string) => a.slice(0, 60)).slice(0, 20) : [],
      images,
    },
    branding: {
      agencyName: str(body.branding?.agencyName, 120) || str(listing.agencyFallback, 120) || "",
      contactLine: str(body.branding?.contactLine, 200),
    },
    clientToken: typeof body.clientToken === "string" ? body.clientToken.slice(0, 100) : undefined,
  };
}

export async function handlePropertyApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;
  const m = req.method || "GET";

  if (m === "OPTIONS" && p.startsWith("/api/property")) {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    res.end();
    return true;
  }

  if (p === "/api/property/config" && m === "GET") {
    const caps = propertyCapabilities();
    const est = estimateCost(52);
    json(res, 200, { ...caps, costEstimate: est, queue: propQueueStats() });
    return true;
  }

  if (p === "/api/property/extract" && m === "POST") {
    try {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf-8") || "{}");
      if (typeof body.url !== "string" || !body.url.trim()) { json(res, 400, { error: "url is required" }); return true; }
      const listing = await extractListing(body.url);
      json(res, 200, { listing });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 422, { error: message });
    }
    return true;
  }

  if (p === "/api/property/upload-avatar" && m === "POST") {
    try {
      const buf = await readBody(req, MAX_AVATAR_BYTES);
      // Accept raw image bytes or a JSON {dataUrl}
      let bytes = buf;
      if (buf.length > 0 && buf[0] === 0x7b) { // '{' JSON
        const parsed = JSON.parse(buf.toString("utf-8"));
        const b64 = String(parsed?.dataUrl || "").replace(/^data:image\/\w+;base64,/, "");
        if (!b64) { json(res, 400, { error: "dataUrl missing" }); return true; }
        bytes = Buffer.from(b64, "base64");
      }
      if (bytes.length < 500 || bytes.length > MAX_AVATAR_BYTES) { json(res, 400, { error: "Avatar must be an image between 0.5 KB and 2 MB" }); return true; }
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8;
      if (!isPng && !isJpeg) { json(res, 400, { error: "Only PNG or JPEG portraits are accepted" }); return true; }
      const id = `avatar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const file = path.join(AVATAR_DIR, id + (isPng ? ".png" : ".jpg"));
      fs.writeFileSync(file, bytes);
      json(res, 201, { avatarId: id });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (p === "/api/property/jobs" && m === "POST") {
    try {
      const body = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString("utf-8") || "{}");
      const draft = validateDraft(body);
      const job = store.createDraft({
        sourceUrl: draft.sourceUrl,
        language: draft.language,
        motionModel: draft.motionModel,
        voiceId: draft.voiceId,
        narration: draft.narration,
        listing: draft.listing,
        branding: draft.branding,
        avatarProvided: typeof body.avatarId === "string" && /^avatar_[a-z0-9_]+$/.test(body.avatarId),
        clientToken: draft.clientToken,
      });
      if (job.avatarProvided && typeof body.avatarId === "string") {
        const src = path.join(AVATAR_DIR, body.avatarId.replace(/\.\./g, "") + ".png");
        const srcJpg = path.join(AVATAR_DIR, body.avatarId.replace(/\.\./g, "") + ".jpg");
        const srcFile = fs.existsSync(src) ? src : fs.existsSync(srcJpg) ? srcJpg : null;
        if (!srcFile) { json(res, 400, { error: "Unknown avatarId" }); return true; }
        fs.mkdirSync(propJobDir(job.id), { recursive: true });
        fs.copyFileSync(srcFile, path.join(propJobDir(job.id), "presenter.png"));
      }
      json(res, 201, { job: publicPropJob(job) });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (p === "/api/property/jobs" && m === "GET") {
    json(res, 200, { jobs: store.list().map(publicPropJob) });
    return true;
  }

  const match = p.match(/^\/api\/property\/jobs\/([a-zA-Z0-9-]+)(\/[a-z]+)?$/);
  if (match) {
    const id = match[1];
    const action = match[2];
    const job = store.get(id);
    if (!job) { json(res, 404, { error: "Job not found" }); return true; }

    if (!action && m === "GET") { json(res, 200, { job: publicPropJob(job) }); return true; }

    if (action === "/generate" && m === "POST") {
      try {
        if (job.avatarProvided && !fs.existsSync(path.join(propJobDir(id), "presenter.png"))) {
          json(res, 400, { error: "Presenter portrait missing — upload again" });
          return true;
        }
        const updated = store.submitForGeneration(id);
        submitPropJob(id);
        json(res, 200, { job: publicPropJob(updated) });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (action === "/cancel" && m === "POST") {
      const updated = store.cancel(id);
      json(res, 200, { job: publicPropJob(updated) });
      return true;
    }

    if (action === "/video" && m === "GET") {
      if (!job.output || !fs.existsSync(job.output.videoPath)) { json(res, 404, { error: "Video not ready" }); return true; }
      const resolved = path.resolve(job.output.videoPath);
      if (!resolved.startsWith(path.resolve(propJobDir(id)) + path.sep)) { json(res, 403, { error: "Forbidden" }); return true; }
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": fs.statSync(resolved).size,
        "Content-Disposition": `attachment; filename="presentation-${id}.mp4"`,
      });
      fs.createReadStream(resolved).pipe(res);
      return true;
    }
  }

  return false;
}

export function initPropertyApi() {
  return { resumed: resumePropJobs(), queue: propQueueStats() };
}
export { store as propertyStore, propStore, downloadImageSafe };
