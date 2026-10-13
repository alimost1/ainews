/**
 * property-runner.ts — Executes property-presentation stages with resumable
 * assets, real provider request IDs, ffprobe-measured durations, and Remotion
 * composition + render.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { spawn } from "child_process";
import { downloadImageSafe } from "./property-extract";
import {
  segmentNarration, elevenTtsSegment, hfAvatarSegment, probeDuration, MAX_SEGMENT_SEC,
} from "./property-presentation";
import { generateRemotionProject, REMOTION_CONFIG, type SegmentPlan } from "./property-compose";
import { PropJobStore, propJobDir, publicPropJob, type PropJobRecord } from "./property-jobs";
import type { PropStage } from "./property-presentation";

const ROOT = path.resolve(__dirname, "../..");
const store = new PropJobStore();
export const propQueue: Array<string> = [];
let propActive = 0;
const PROP_CONCURRENCY = Math.max(1, Number(process.env.IANEWS_PROP_CONCURRENCY || "1"));

export function propQueueStats() { return { active: propActive, queued: propQueue.length, concurrency: PROP_CONCURRENCY }; }

function hfKeys() {
  const keyId = process.env.HF_API_KEY_ID || "";
  const keySecret = process.env.HF_API_KEY_SECRET || "";
  const elevenKey = process.env.ELEVENLABS_API_KEY || "";
  return { keyId, keySecret, elevenKey };
}

function runStage(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", killed = false;
    const t = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", d => { out += d; if (out.length > 300_000) out = out.slice(-150_000); });
    child.stderr.on("data", d => { err += d; if (err.length > 300_000) err = err.slice(-150_000); });
    child.on("error", e => { clearTimeout(t); reject(e); });
    child.on("close", code => {
      clearTimeout(t);
      if (killed) reject(new Error("Stage timed out"));
      else resolve({ code: code ?? -1, stderr: err, stdout: out });
    });
  });
}

function npx() { return process.platform === "win32" ? "npx.cmd" : "npx"; }

async function executePropJob(jobId: string): Promise<void> {
  let job = store.get(jobId);
  if (!job || job.status === "canceled") return;
  const { keyId, keySecret, elevenKey } = hfKeys();
  if (!keyId || !keySecret) { store.update(jobId, { status: "failed", error: "Higgsfield lip-sync not configured: set HF_API_KEY_ID and HF_API_KEY_SECRET (open.higgsfield.ai). The avatar stage uses the verified wan/v2.7/image-to-video endpoint with image_url + audio_url." }); return; }
  if (!elevenKey) { store.update(jobId, { status: "failed", error: "ElevenLabs not configured: set ELEVENLABS_API_KEY for narration voice." }); return; }

  const dir = propJobDir(jobId);
  const renderDir = path.join(dir, "render");
  const pub = path.join(renderDir, "public");
  store.update(jobId, { status: "running" });

  const stageRun = async (stage: PropStage, fn: () => Promise<void>) => {
    job = store.get(jobId)!;
    if (job.status === "canceled") throw new Error("canceled");
    const rec = job.stages[stage];
    if (rec.status === "completed" || rec.status === "skipped") return;
    store.updateStage(jobId, stage, { status: "running", attempts: rec.attempts + 1, startedAt: new Date().toISOString(), error: undefined });
    try {
      await fn();
      store.updateStage(jobId, stage, { status: "completed", finishedAt: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.updateStage(jobId, stage, { status: "failed", error: message.slice(0, 1000), finishedAt: new Date().toISOString() });
      throw err;
    }
  };

  try {
    // ── script: segment the reviewed narration ─────────────────────
    let segments = store.get(jobId)!.segments;
    await stageRun("script", async () => {
      const segs = segmentNarration(store.get(jobId)!.narration, MAX_SEGMENT_SEC);
      segments = segs.map(text => ({ text }));
      store.update(jobId, { segments });
    });
    if (!segments) throw new Error("No segments");

    // ── voice: ElevenLabs per segment, ffprobe-measured ─────────────
    const audioDir = path.join(pub, "audio");
    fs.mkdirSync(audioDir, { recursive: true });
    const plan: SegmentPlan[] = [];
    for (let i = 0; i < segments.length; i++) {
      const segFile = path.join(audioDir, `seg_${String(i + 1).padStart(2, "0")}.mp3`);
      const staticAudio = `audio/seg_${String(i + 1).padStart(2, "0")}.mp3`;
      const seg = segments[i];
      await stageRun("voice" as PropStage, async () => {
        if (!(fs.existsSync(segFile) && fs.statSync(segFile).size > 200)) {
          await elevenTtsSegment(seg.text, store.get(jobId)!.voiceId, elevenKey, segFile);
        }
        const dur = probeDuration(segFile);
        seg.audioSec = dur;
        const j = store.get(jobId)!;
        j.segments![i].audioSec = dur;
        store.update(jobId, { segments: j.segments });
      });
      plan.push({ text: seg.text, audioFile: staticAudio, avatarClip: "", durationSec: seg.audioSec ?? 5, photoFile: undefined, caption: undefined });
    }
    if (store.get(jobId)!.stages.voice.status !== "completed") store.updateStage(jobId, "voice", { status: "completed" });

    // ── photos: download selected gallery images (SSRF-safe) ───────
    const photoDir = path.join(pub, "photos");
    fs.mkdirSync(photoDir, { recursive: true });
    const images = store.get(jobId)!.listing.images;
    const photoFiles: string[] = [];
    for (let i = 0; i < Math.min(images.length, plan.length); i++) {
      const dest = path.join(photoDir, `photo_${String(i + 1).padStart(2, "0")}.jpg`);
      if (!(fs.existsSync(dest) && fs.statSync(dest).size > 500)) {
        const buf = await downloadImageSafe(images[i]);
        fs.writeFileSync(dest, buf);
      }
      photoFiles.push(`photos/photo_${String(i + 1).padStart(2, "0")}.jpg`);
    }

    // ── avatar: presenter image (uploaded) + Higgsfield lipsync per segment ──
    const avatarDir = path.join(pub, "avatar");
    fs.mkdirSync(avatarDir, { recursive: true });
    const presenterPath = path.join(dir, "presenter.png");
    await stageRun("avatar", async () => {
      const j = store.get(jobId)!;
      if (!fs.existsSync(presenterPath)) {
        // Uploaded portrait was stored server-side at draft time
        throw new Error("Presenter portrait missing — upload an avatar first");
      }
      // The public media server exposes /media/prop/<jobId>/... for Higgsfield fetches
      const publicBase = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:8090`).replace(/\/$/, "");
      const presenterUrl = `${publicBase}/media/prop/${jobId}/presenter.png`;
      const ids: string[] = [];
      for (let i = 0; i < plan.length; i++) {
        const segAudioPublic = `${publicBase}/media/prop/${jobId}/audio/seg_${String(i + 1).padStart(2, "0")}.mp3`;
        const clipLocal = path.join(avatarDir, `seg_${String(i + 1).padStart(2, "0")}.mp4`);
        if (fs.existsSync(clipLocal) && fs.statSync(clipLocal).size > 10_000) {
          plan[i].avatarClip = `avatar/seg_${String(i + 1).padStart(2, "0")}.mp4`;
          continue; // resume completed clip
        }
        const result = await hfAvatarSegment({
          keyId, keySecret,
          imageUrl: presenterUrl,
          audioUrl: segAudioPublic,
          prompt: "She presents a property listing with warm professional gestures, natural lip sync with the provided audio, subtle head movements, steady gaze",
          durationSec: Math.max(2, Math.min(plan[i].durationSec + 0.5, 15)),
          aspectRatio: "9:16",
        });
        ids.push(result.requestId);
        const dl = await fetch(result.videoUrl);
        if (!dl.ok) throw new Error(`Avatar clip download failed ${dl.status}`);
        fs.writeFileSync(clipLocal, Buffer.from(await dl.arrayBuffer()));
        plan[i].avatarClip = `avatar/seg_${String(i + 1).padStart(2, "0")}.mp4`;
      }
      store.updateStage(jobId, "avatar", { providerRequestIds: ids });
    });

    // Attach photos + captions to plan
    const j = store.get(jobId)!;
    const caps = plan.length;
    for (let i = 0; i < plan.length; i++) {
      plan[i].photoFile = photoFiles[i % Math.max(photoFiles.length, 1)] || undefined;
      if (i === 0) plan[i].caption = j.listing.title;
      else if (i === caps - 1) plan[i].caption = j.branding.contactLine || j.branding.agencyName;
    }

    // ── compose: generate Remotion project ──────────────────────────
    await stageRun("compose", async () => {
      generateRemotionProject({ jobDir: dir, plan, input: j, fps: 30 });
      fs.writeFileSync(path.join(renderDir, "remotion.config.ts"), REMOTION_CONFIG);
    });

    // ── render ─────────────────────────────────────────────────────
    const outPath = path.join(dir, "output.mp4");
    await stageRun("render", async () => {
      const r = await runStage(npx(), ["remotion", "render", "index.tsx", "PropertyPresentation", outPath,
        "--public-dir", pub], renderDir, 20 * 60 * 1000);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || "render failed").split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 500));
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 10_000) throw new Error("Rendered MP4 missing or too small");
      const dur = probeDuration(outPath);
      store.update(jobId, { actualDurationSec: Math.round(dur * 10) / 10 });
    });

    store.update(jobId, {
      status: "completed",
      output: { videoPath: outPath, bytes: fs.statSync(outPath).size },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "canceled") { store.update(jobId, { status: "canceled" }); return; }
    store.update(jobId, { status: "failed", error: message.slice(0, 1000) });
  }
}

export function submitPropJob(jobId: string): void {
  propQueue.push(jobId);
  drainPropQueue();
}

function drainPropQueue(): void {
  while (propActive < PROP_CONCURRENCY && propQueue.length) {
    const id = propQueue.shift()!;
    propActive++;
    executePropJob(id).finally(() => { propActive--; drainPropQueue(); });
  }
}

/** Server restart: requeue queued/running jobs. */
export function resumePropJobs(): number {
  let n = 0;
  for (const job of store.list()) {
    if (job.status === "queued" || job.status === "running") {
      const inFlight = (Object.keys(job.stages) as PropStage[]).find(s => job.stages[s].status === "running");
      if (inFlight) store.updateStage(job.id, inFlight, { status: "failed", error: "Interrupted by server restart" });
      store.update(job.id, { status: "queued" });
      submitPropJob(job.id);
      n++;
    }
  }
  return n;
}

export { store as propStore, publicPropJob };
