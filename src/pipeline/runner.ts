/**
 * runner.ts — Executes generation stages for a job in its isolated workspace.
 *
 * Stage subprocesses inherit environment overrides that point CONFIG (shared.ts)
 * at the job's workspace, so no two jobs ever touch the same script.json or assets.
 *
 * - Completed stages are skipped (resume), pending/failed stages are executed.
 * - Each stage has a hard timeout and bounded stdout/stderr capture.
 * - Real provider request IDs are captured from OpenRouter responses via a
 *   provider log file the agents append to (IANEWS_PROVIDER_LOG).
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  ALL_STAGES, sharedJobStore, jobWorkspace, runStageProcess, BoundedQueue,
  type JobRecord, type StageName,
} from "./jobs";
import { pipelineOptions } from "./options";

const ROOT = path.resolve(__dirname, "../..");
const QUEUE_CONCURRENCY = Math.max(1, Number(process.env.IANEWS_QUEUE_CONCURRENCY || "1"));
const STAGE_TIMEOUT_MS = Number(process.env.IANEWS_STAGE_TIMEOUT_MS || String(15 * 60 * 1000));

const store = sharedJobStore();
export const queue = new BoundedQueue(QUEUE_CONCURRENCY);

// Dimensions per format
export function dimensionsFor(format: JobRecord["format"]): { width: number; height: number } {
  if (format === "16:9") return { width: 1920, height: 1080 };
  if (format === "1:1") return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 }; // 9:16 vertical (default)
}

function npxCmd(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

/** Environment overrides that redirect CONFIG paths into the job workspace. */
function stageEnv(job: JobRecord): Record<string, string> {
  const ws = jobWorkspace(job.id);
  const { width, height } = dimensionsFor(job.format);
  return {
    IANEWS_DATA_DIR: ws.dir,
    IANEWS_IMAGES_DIR: path.join(ws.publicDir, "images"),
    IANEWS_AUDIO_DIR: path.join(ws.publicDir, "audio"),
    IANEWS_OUTPUT_DIR: ws.outputDir,
    IANEWS_EDITOR_DIR: ws.renderDir,
    VIDEO_LANGUAGE: job.language,
    VIDEO_DURATION: String(job.targetDurationSec),
    VIDEO_WIDTH: String(width),
    VIDEO_HEIGHT: String(height),
    IANEWS_PROVIDER_LOG: path.join(ws.dir, "provider_ids.log"),
  };
}

interface StageSpec {
  name: StageName;
  args: string[];
  /** Stage runs with cwd = render dir (remotion render). */
  cwdRender?: boolean;
  /** Validate that this stage's outputs exist before marking completed. */
  validate?: (job: JobRecord) => void;
}

function stageSpecs(job: JobRecord): StageSpec[] {
  const ws = jobWorkspace(job.id);
  const specs: StageSpec[] = [
    {
      name: "research",
      args: ["tsx", "src/agents/Director.ts", "--topic", job.topic, "--duration", String(job.targetDurationSec)],
      validate: () => { if (!fs.existsSync(path.join(ws.dir, "director_output.json"))) throw new Error("director_output.json missing"); },
    },
    {
      name: "script",
      args: ["tsx", "src/agents/ScriptWriter.ts", "--topic", job.topic],
      validate: () => { if (!fs.existsSync(path.join(ws.dir, "script.json"))) throw new Error("script.json missing"); },
    },
    {
      name: "images",
      args: ["tsx", "src/agents/VisualArtist.ts"],
      validate: () => {
        const script = JSON.parse(fs.readFileSync(path.join(ws.dir, "script.json"), "utf-8"));
        for (const s of script.scenes) {
          const p = path.join(ws.publicDir, "images", `scene_${s.scene_number}.jpg`);
          if (!fs.existsSync(p) || fs.statSync(p).size < 500) throw new Error(`Image for scene ${s.scene_number} missing`);
        }
      },
    },
    {
      name: "voice",
      args: ["tsx", "src/agents/VoiceDirector.ts"],
      validate: () => {
        const script = JSON.parse(fs.readFileSync(path.join(ws.dir, "script.json"), "utf-8"));
        for (const s of script.scenes) {
          const p = path.join(ws.publicDir, "audio", `scene_${s.scene_number}.mp3`);
          if (!fs.existsSync(p) || fs.statSync(p).size <= 44) throw new Error(`Audio for scene ${s.scene_number} missing or corrupt`);
          const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", p], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
          if (!Number.isFinite(dur) || dur <= 0) throw new Error(`Audio for scene ${s.scene_number} has invalid duration`);
        }
      },
    },
    {
      name: "edit",
      args: ["tsx", "src/agents/Editor.ts"],
      validate: () => { if (!fs.existsSync(path.join(ws.renderDir, "index.tsx"))) throw new Error("Composition not generated"); },
    },
  ];
  if (!job.skipRender) {
    specs.push({
      name: "render",
      args: ["remotion", "render", "index.tsx", "VideoComposition",
        path.join(ws.outputDir, "output.mp4"), "--public-dir", path.join(ws.publicDir)],
      cwdRender: true,
      validate: () => {
        const out = path.join(ws.outputDir, "output.mp4");
        if (!fs.existsSync(out) || fs.statSync(out).size < 10_000) throw new Error("Rendered video missing or too small");
        const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1", out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
        if (!Number.isFinite(dur) || dur <= 0) throw new Error("Rendered video has invalid duration");
      },
    });
  }
  return specs;
}

function readProviderIds(jobId: string): string[] {
  const log = path.join(jobWorkspace(jobId).dir, "provider_ids.log");
  try {
    return fs.readFileSync(log, "utf-8").split("\n").map(l => l.trim()).filter(Boolean);
  } catch { return []; }
}

async function executeJob(jobId: string): Promise<void> {
  const job = store.get(jobId);
  if (!job) return;
  if (job.status === "canceled") return;

  const startedAt = Date.now();
  store.update(jobId, { status: "running", startedAt: new Date().toISOString(), error: undefined });
  const ws = jobWorkspace(jobId);

  try {
    for (const spec of stageSpecs(job)) {
      // Re-fetch to observe cancellation between stages
      const current = store.get(jobId)!;
      if (current.status === "canceled") return;

      const rec = current.stages[spec.name];
      if (rec.status === "completed" || rec.status === "skipped") continue; // resume: keep completed assets

      store.updateStage(jobId, spec.name, {
        status: "running", startedAt: new Date().toISOString(), attempts: rec.attempts + 1, error: undefined,
      });
      store.update(jobId, { stage: spec.name });

      try {
        const env = stageEnv(current);
        const cwd = spec.cwdRender ? ws.renderDir : ROOT;
        const result = await runStageProcess(npxCmd(), spec.args, { cwd, env, timeoutMs: STAGE_TIMEOUT_MS });
        if (result.code !== 0) {
          const tail = (result.stderr || result.stdout || "").split("\n").filter(Boolean).slice(-5).join(" | ");
          throw new Error(tail.slice(0, 500) || `Stage exited with code ${result.code}`);
        }
        spec.validate?.(current);
        store.updateStage(jobId, spec.name, {
          status: "completed", finishedAt: new Date().toISOString(),
          providerRequestIds: readProviderIds(jobId).slice(-20),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.updateStage(jobId, spec.name, { status: "failed", finishedAt: new Date().toISOString(), error: message.slice(0, 1000) });
        throw err;
      }
    }

    // Completed: record actual rendered duration distinctly from the target.
    const patch: Partial<JobRecord> = {
      status: "completed", finishedAt: new Date().toISOString(), stage: null,
      lastRunMs: Date.now() - startedAt,
    };
    const out = path.join(ws.outputDir, "output.mp4");
    if (!job.skipRender && fs.existsSync(out)) {
      const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
      if (Number.isFinite(dur) && dur > 0) patch.actualDurationSec = Math.round(dur * 10) / 10;
      patch.output = { videoPath: out, bytes: fs.statSync(out).size };
    }
    store.update(jobId, patch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.update(jobId, { status: "failed", error: message.slice(0, 1000), finishedAt: new Date().toISOString(), lastRunMs: Date.now() - startedAt });
  }
}

export function submitJob(jobId: string): void {
  queue.submit(jobId, () => executeJob(jobId));
}

/** On server start: requeue jobs that were running or queued before the restart. */
export function resumeInterruptedJobs(): number {
  let requeued = 0;
  for (const job of store.list()) {
    if (job.status === "running") {
      // The stage subprocesses died with the server; mark the in-flight stage failed
      // so the retry logic can restart it cleanly, then requeue.
      const inFlight = ALL_STAGES.find(s => job.stages[s].status === "running");
      if (inFlight) store.updateStage(job.id, inFlight, { status: "failed", error: "Interrupted by server restart", finishedAt: new Date().toISOString() });
      store.update(job.id, { status: "queued" });
      submitJob(job.id);
      requeued++;
    } else if (job.status === "queued") {
      submitJob(job.id);
      requeued++;
    }
  }
  return requeued;
}

export function queueStats() {
  return { concurrency: QUEUE_CONCURRENCY, active: queue.activeCount, queued: queue.queuedCount };
}

// CLI entry: run a job synchronously (used by tests and direct CLI use)
if (require.main === module) {
  const { topic, duration } = pipelineOptions(process.argv.slice(2));
  const language = process.env.VIDEO_LANGUAGE === "en" ? "en" as const : "ar" as const;
  const format = (process.env.VIDEO_FORMAT === "16:9" || process.env.VIDEO_FORMAT === "1:1" || process.env.VIDEO_FORMAT === "9:16")
    ? process.env.VIDEO_FORMAT as JobRecord["format"] : "9:16";
  const job = store.create({ topic, language, targetDurationSec: duration, format });
  console.log(`Job ${job.id} — ${job.topic} (${language}, ${duration}s, ${format})`);
  executeJob(job.id).then(() => {
    const done = store.get(job.id)!;
    if (done.status === "completed") {
      console.log(`✅ completed${done.actualDurationSec ? ` — rendered ${done.actualDurationSec}s (target ${done.targetDurationSec}s)` : ""}`);
      if (done.output) console.log(`   ${done.output.videoPath}`);
      process.exit(0);
    }
    console.error(`❌ ${done.status}: ${done.error}`);
    process.exit(1);
  });
}
