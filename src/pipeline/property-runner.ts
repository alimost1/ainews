/**
 * property-runner.ts — Executes property-presentation stages with resumable
 * assets, real provider request IDs, ffprobe-measured durations, and Remotion
 * composition + render.
 */
import * as fs from "fs";
import { generateHiggsfield, motionRequest, MOTION_MODELS, type RequestHandle } from "./property-models";
import {
  PRESENTER_MODEL, generateSoulImage, presenterDisclosure, presenterReferencePrompt,
  presenterSceneRequest, presenterReferenceRequest, scenePrepPrompt, planPresenterShots,
} from "./property-presenter";
import { prepareNarrationAudio } from "./property-audio";
import type { GalleryAsset } from "./property-cinematic";
import * as path from "path";
import { execFileSync } from "child_process";
import { spawn } from "child_process";
import { downloadImageSafe } from "./property-extract";
import {
  segmentNarration, elevenTtsSegment, hfAvatarSegment, probeDuration, MAX_SEGMENT_SEC,
} from "./property-presentation";
import { generateRemotionProject, makeRemotionConfig, type SegmentPlan } from "./property-compose";
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
    const originalImageUrls: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const dest = path.join(photoDir, `photo_${String(i + 1).padStart(2, "0")}.jpg`);
      if (!(fs.existsSync(dest) && fs.statSync(dest).size > 500)) {
        const buf = await downloadImageSafe(images[i]);
        fs.writeFileSync(dest, buf);
      }
      photoFiles.push(`photos/photo_${String(i + 1).padStart(2, "0")}.jpg`);
      originalImageUrls.push(images[i]);
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
        const stage: PropStage = name.startsWith("motion") ? "motion"
          : name.startsWith("presenter_ref") ? "presenter"
          : name.startsWith("scene") ? "scenePrep" : "lipsync";
        const ids = store.get(jobId)!.stages[stage].providerRequestIds || [];
        store.updateStage(jobId, stage, { providerRequestIds: [...new Set([...ids, handle.requestId])] });
      } };
    }
    const presenterMode = store.get(jobId)!.mode === "presenter";

    // ── presenter: synthetic reference portrait (presenter mode only) ──
    await stageRun("presenter", async () => {
      if (!presenterMode) { store.updateStage(jobId, "presenter", { status: "skipped" }); return; }
      requireHf();
      const publicUrl = new URL(publicBase || "http://localhost");
      // Allow HTTP for local testing; production should use HTTPS
      if (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:" || /^(localhost|127\.|\[::1\])/.test(publicUrl.hostname)) {
        throw new Error("Set PUBLIC_BASE_URL to a public HTTPS/HTTP address of this server before presenter generation");
      }
      const refFile = path.join(pub, "presenter.png");
      if (!(fs.existsSync(refFile) && fs.statSync(refFile).size > 10_000)) {
        if (!photoFiles.length) throw new Error("Select at least one property photo");
        const result = await generateSoulImage({ keyId, keySecret, ...requestState("presenter_ref"),
          input: presenterReferenceRequest(presenterReferencePrompt()) });
        const dl = await fetch(result.imageUrl, { signal: AbortSignal.timeout(120000) });
        if (!dl.ok) throw new Error(`Presenter reference download failed (${dl.status})`);
        const tmp = refFile + ".tmp";
        fs.writeFileSync(tmp, Buffer.from(await dl.arrayBuffer()));
        fs.renameSync(tmp, refFile);
      }
    });
    // sceneFiles must be declared before lipsync stage since lipsync runs before scenePrep
    const sceneFiles: string[] = [];
    // ── lipsync: Wan 2.7 per segment (uploaded portrait in panel mode,
    //    synthetic presenter-in-scene images in presenter mode) ──
    await stageRun("lipsync", async () => {
      requireHf();
      const j = store.get(jobId)!;
      // The public media server exposes /media/prop/<jobId>/... for Higgsfield fetches
      const publicUrl = new URL(publicBase || "http://localhost");
      // Allow HTTP for local testing; production should use HTTPS
      if (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:" || /^(localhost|127\.|\[::1\])/.test(publicUrl.hostname)) {
        throw new Error("Set PUBLIC_BASE_URL to a public HTTPS/HTTP address of this server before avatar generation");
      }
      if (!presenterMode) {
        if (!fs.existsSync(presenterPath)) {
          // Uploaded portrait was stored server-side at draft time
          throw new Error("Presenter portrait missing — upload an avatar first");
        }
      }
      const panelUrl = `${publicBase}/media/prop/${jobId}/presenter.png`;

      for (let i = 0; i < plan.length; i++) {
        if (store.get(jobId)!.status === "canceled") throw new Error("canceled");
        const segAudioPublic = `${publicBase}/media/prop/${jobId}/audio/seg_${String(i + 1).padStart(2, "0")}.mp3`;
        const clipLocal = path.join(avatarDir, `seg_${String(i + 1).padStart(2, "0")}.mp4`);
        if (fs.existsSync(clipLocal) && fs.statSync(clipLocal).size > 10_000) {
          plan[i].avatarClip = `avatar/seg_${String(i + 1).padStart(2, "0")}.mp4`;
          continue; // resume completed clip
        }
        const sceneUrl = presenterMode ? panelUrl : panelUrl;
        const result = await hfAvatarSegment({
          keyId, keySecret, ...requestState(`avatar_${i}`),
          imageUrl: sceneUrl,
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

        // ── scenePrep: composite presenter into each property photo with ffmpeg (presenter mode only) ──
            const sceneDir = path.join(pub, "scenes");
            fs.mkdirSync(sceneDir, { recursive: true });
            await stageRun("scenePrep", async () => {
              if (!presenterMode) { store.updateStage(jobId, "scenePrep", { status: "skipped" }); return; }
              requireHf();
              if (!fs.existsSync(path.join(pub, "presenter.png"))) throw new Error("Presenter reference missing — the presenter stage must complete first");
              if (!fs.existsSync(path.join(pub, "avatar", "seg_01.mp4"))) throw new Error("Avatar clip missing — the lipsync stage must complete first");
              // Use the first avatar clip as the presenter video (looped)
              const presenterVideo = path.join(pub, "avatar", "seg_01.mp4");
              for (let i = 0; i < photoFiles.length; i++) {
                if (store.get(jobId)!.status === "canceled") throw new Error("canceled");
                const srcPhoto = path.join(pub, photoFiles[i]);
                const destScene = path.join(sceneDir, `scene_${String(i + 1).padStart(2, "0")}.jpg`);
                if (fs.existsSync(destScene) && fs.statSync(destScene).size > 10_000) {
                  sceneFiles.push(`scenes/scene_${String(i + 1).padStart(2, "0")}.jpg`);
                  continue;
                }
                // Composite: overlay presenter video frame onto property photo
                // Position presenter at different locations
                const positions = ['left', 'right', 'center'];
                const pos = positions[i % positions.length];
                const xPos = pos === 'left' ? '0.12' : pos === 'right' ? '0.72' : '0.42';
                const yPos = '0.58';
                const scale = '0.38';
                // ffmpeg: overlay video frame at position with shadow
                const overlayFilter = `[1:v]scale=iw*${scale}:-1[ov];[0:v][ov]overlay=x=W*${xPos}-ow/2:y=H*${yPos}-oh:shortest=1,drawbox=x=W*${xPos}-ow/2:y=H*${yPos}+oh*0.9:w=ow*0.45:h=3:color=black@0.25:t=fill:enable='between(t,0,10)'[v];[v]boxblur=8:1[shadow];[0:v][shadow]overlay=x=W*${xPos}-ow/2:y=H*${yPos}+oh*0.9:w=ow*0.45:h=3:shortest=1`;
                try {
                  execFileSync("ffmpeg", [
                    "-y", "-v", "error", "-i", srcPhoto,
                    "-stream_loop", "-1", "-i", presenterVideo,
                    "-filter_complex", overlayFilter,
                    "-frames:v", "1", "-q:v", "2", destScene
                  ], { timeout: 120000 });
                } catch (e) {
                  // Fallback: copy original photo
                  fs.copyFileSync(srcPhoto, destScene);
                }
                if (fs.existsSync(destScene) && fs.statSync(destScene).size > 10_000) {
                  sceneFiles.push(`scenes/scene_${String(i + 1).padStart(2, "0")}.jpg`);
                } else {
                  fs.copyFileSync(srcPhoto, destScene);
                  sceneFiles.push(`scenes/scene_${String(i + 1).padStart(2, "0")}.jpg`);
                }
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

    // Build presenter gallery for presenter mode
    let galleryFinal = gallery;
    if (j.mode === "presenter") {
      const avatarUrls = plan.map(s => s.avatarClip).filter(Boolean);
      galleryFinal = planPresenterShots(
        photoFiles,
        avatarUrls
      );
    }

    // ── compose: generate Remotion project (mode: 'panel' default | 'presenter') ──
    await stageRun("compose", async () => {
      const mode = j.mode === "presenter" ? "presenter" : "panel";
      generateRemotionProject({ jobDir: dir, plan, input: j, fps: 30, gallery: galleryFinal, mode });
      const vendorChrome = path.join(ROOT, "vendor", "chrome-headless-shell", "chrome-headless-shell-linux64", "chrome-headless-shell");
      fs.writeFileSync(path.join(renderDir, "remotion.config.ts"),
        makeRemotionConfig(fs.existsSync(vendorChrome) ? vendorChrome : (process.env.REMOTION_BROWSER_EXECUTABLE || null)));
    });

    // ── render ─────────────────────────────────────────────────────
    const outPath = path.join(dir, "output.mp4");
    await stageRun("render", async () => {
      const r = await runStage(npx(), ["remotion", "render", "index.tsx", "PropertyPresentation", outPath,
        "--public-dir", pub], renderDir, 60 * 60 * 1000);
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
