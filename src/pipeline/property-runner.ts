/**
 * property-runner.ts — Executes property-presentation stages with resumable
 * assets, real provider request IDs, ffprobe-measured durations, and Remotion
 * composition + render.
 */
import * as fs from "fs";
import { generateHiggsfield, motionRequest, MOTION_MODELS, type RequestHandle } from "./property-models";
import { prepareNarrationAudio } from "./property-audio";
import type { GalleryAsset } from "./property-cinematic";
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
  // Per-stage configuration gates: stages whose provider is unconfigured fail
  // with an explicit message; stages that CAN run still run (so partial
  // setups produce everything they can, and retries only redo what's missing).
  const requireEleven = () => { if (!elevenKey) throw new Error("ElevenLabs not configured: set ELEVENLABS_API_KEY for narration voice."); };
  const requireHf = () => { if (!keyId || !keySecret) throw new Error("Higgsfield lip-sync not configured: set HF_API_KEY_ID and HF_API_KEY_SECRET (open.higgsfield.ai). The avatar stage uses the verified wan/v2.7/image-to-video endpoint with image_url + audio_url."); };

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
    await stageRun("voice", async () => {
      requireEleven();
      await prepareNarrationAudio({segments: segments!, audioDir,
        generate: (text, file) => elevenTtsSegment(text, store.get(jobId)!.voiceId, elevenKey, file),
        probe: probeDuration, save: () => { store.update(jobId, { segments }); },
      });
    });
    segments = store.get(jobId)!.segments!;
    const plan: SegmentPlan[] = segments.map((seg, i) => ({
      text: seg.text, audioFile: `audio/seg_${String(i + 1).padStart(2, "0")}.mp3`,
      avatarClip: `avatar/seg_${String(i + 1).padStart(2, "0")}.mp4`,
      durationSec: probeDuration(path.join(audioDir, `seg_${String(i + 1).padStart(2, "0")}.mp3`)),
    }));

    // ── photos: download selected gallery images (SSRF-safe) ───────
    const photoDir = path.join(pub, "photos");
    fs.mkdirSync(photoDir, { recursive: true });
    const images = store.get(jobId)!.listing.images;
    const photoFiles: string[] = [];
    for (let i = 0; i < images.length; i++) {
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
    const publicBase = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const requestsDir = path.join(dir, "requests");
    fs.mkdirSync(requestsDir, { recursive: true });
    function requestState(name: string) {
      const file = path.join(requestsDir, name + ".json");
      const resume: RequestHandle | undefined = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
      return { resume, onSubmitted: (handle: RequestHandle) => {
        fs.writeFileSync(file, JSON.stringify(handle));
        const stage: PropStage = name.startsWith("motion") ? "motion" : "avatar";
        const ids = store.get(jobId)!.stages[stage].providerRequestIds || [];
        store.updateStage(jobId, stage, { providerRequestIds: [...new Set([...ids, handle.requestId])] });
      } };
    }
    await stageRun("avatar", async () => {
      requireHf();
      const j = store.get(jobId)!;
      if (!fs.existsSync(presenterPath)) {
        // Uploaded portrait was stored server-side at draft time
        throw new Error("Presenter portrait missing — upload an avatar first");
      }
      // The public media server exposes /media/prop/<jobId>/... for Higgsfield fetches
      const publicUrl = new URL(publicBase || "http://localhost");
      if (publicUrl.protocol !== "https:" || /^(localhost|127\.|\[::1\])/.test(publicUrl.hostname)) {
        throw new Error("Set PUBLIC_BASE_URL to the public HTTPS address of this server before avatar generation");
      }
      const presenterUrl = `${publicBase}/media/prop/${jobId}/presenter.png`;

      for (let i = 0; i < plan.length; i++) {
        if (store.get(jobId)!.status === "canceled") throw new Error("canceled");
        const segAudioPublic = `${publicBase}/media/prop/${jobId}/audio/seg_${String(i + 1).padStart(2, "0")}.mp3`;
        const clipLocal = path.join(avatarDir, `seg_${String(i + 1).padStart(2, "0")}.mp4`);
        if (fs.existsSync(clipLocal) && fs.statSync(clipLocal).size > 10_000) {
          plan[i].avatarClip = `avatar/seg_${String(i + 1).padStart(2, "0")}.mp4`;
          continue; // resume completed clip
        }
        const result = await hfAvatarSegment({
          keyId, keySecret, ...requestState(`avatar_${i}`),
          imageUrl: presenterUrl,
          audioUrl: segAudioPublic,
          prompt: "The presenter introduces the property with restrained professional hand gestures, natural lip sync following the provided audio exactly, steady gaze and consistent appearance. Keep the same face and outfit.",
          durationSec: plan[i].durationSec,
          aspectRatio: "9:16",
        });

        const dl = await fetch(result.videoUrl, { signal: AbortSignal.timeout(120000) });
        if (!dl.ok) throw new Error(`Avatar clip download failed ${dl.status}`);
        const tmp = clipLocal + ".tmp";
        fs.writeFileSync(tmp, Buffer.from(await dl.arrayBuffer()));
        if (probeDuration(tmp) + 0.1 < plan[i].durationSec) throw new Error(`Avatar segment ${i + 1} is shorter than narration`);
        fs.renameSync(tmp, clipLocal);
        plan[i].avatarClip = `avatar/seg_${String(i + 1).padStart(2, "0")}.mp4`;
      }

    });

    // All selected photos participate independently of the narration segment count.
    const gallery: GalleryAsset[] = photoFiles.map(photo => ({ photo }));
    const j = store.get(jobId)!;
    await stageRun("motion", async () => {
      const model = j.motionModel || "photo";
      if (model === "photo") return;
      requireHf();
      const motionDir = path.join(pub, "motion");
      fs.mkdirSync(motionDir, { recursive: true });
      for (let i = 0; i < gallery.length; i++) {
        if (store.get(jobId)!.status === "canceled") throw new Error("canceled");
        const file = path.join(motionDir, `shot_${i}.mp4`);
        if (!(fs.existsSync(file) && fs.statSync(file).size > 10000)) {
          const result = await generateHiggsfield({ keyId, keySecret, endpoint: MOTION_MODELS[model].endpoint,
            input: motionRequest(model, `${publicBase}/media/prop/${jobId}/${photoFiles[i]}`, i),
            ...requestState(`motion_${i}`) });
          const dl = await fetch(result.videoUrl, { signal: AbortSignal.timeout(120000) });
          if (!dl.ok) throw new Error(`Motion download failed (${dl.status})`);
          const tmp = file + ".tmp";
          fs.writeFileSync(tmp, Buffer.from(await dl.arrayBuffer()));
          probeDuration(tmp);
          fs.renameSync(tmp, file);
        }
      }
    });
    if (j.motionModel && j.motionModel !== "photo") {
      gallery.forEach((asset, i) => { asset.video = `motion/shot_${i}.mp4`; });
    }

    // ── compose: generate Remotion project ──────────────────────────
    await stageRun("compose", async () => {
      generateRemotionProject({ jobDir: dir, plan, input: j, fps: 30, gallery });
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

    if (store.get(jobId)!.status === "canceled") return;
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
