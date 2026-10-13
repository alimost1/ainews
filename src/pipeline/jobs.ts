/**
 * jobs.ts — Durable job manager for video generation
 *
 * - Each job gets a unique ID and an isolated workspace: data/jobs/<id>/ with
 *   its own script.json, director_output.json, images/, audio/, and render assets.
 * - Job records persist to data/jobs/index.json (atomic writes) and survive restarts.
 * - A bounded queue runs one job at a time (Remotion renders and image/TTS
 *   generation are heavy; this app deploys on a small VPS).
 * - Failed stages can be retried; completed stages and their assets are reused.
 * - Provider request IDs are the real IDs returned by providers, never invented.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawn } from "child_process";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export type StageName = "research" | "script" | "images" | "voice" | "edit" | "render";

export const ALL_STAGES: StageName[] = ["research", "script", "images", "voice", "edit", "render"];

export interface StageRecord {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  error?: string;
  /** Real provider request IDs observed during this stage (OpenRouter/HF/etc). */
  providerRequestIds?: string[];
}

export interface JobRecord {
  id: string;
  topic: string;
  language: "ar" | "en";
  targetDurationSec: number;
  format: "9:16" | "16:9" | "1:1";
  skipRender: boolean;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  stage: StageName | null;
  stages: Record<StageName, StageRecord>;
  /** Total wall time of the last run, ms */
  lastRunMs?: number;
  /** Actual rendered duration in seconds, measured with ffprobe after render. */
  actualDurationSec?: number;
  output?: { videoPath: string; bytes: number };
  error?: string;
  /** Idempotency: a client-supplied token prevents duplicate submissions. */
  clientToken?: string;
}

export interface CreateJobInput {
  topic: string;
  language: "ar" | "en";
  targetDurationSec: number;
  format: "9:16" | "16:9" | "1:1";
  skipRender?: boolean;
  clientToken?: string;
}

const ROOT = path.resolve(__dirname, "../..");
const JOBS_ROOT = path.join(ROOT, "data", "jobs");
const INDEX_PATH = process.env.IANEWS_JOBS_INDEX || path.join(JOBS_ROOT, "index.json");
const MAX_COMPLETED_HISTORY = 200;
const STAGE_TIMEOUT_MS = 15 * 60 * 1000; // hard cap per stage subprocess

fs.mkdirSync(JOBS_ROOT, { recursive: true });

// ─── Persistence ─────────────────────────────────────────────────
function readIndex(): Record<string, JobRecord> {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeIndexAtomic(jobs: Record<string, JobRecord>): void {
  const tmp = INDEX_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  fs.renameSync(tmp, INDEX_PATH);
}

// ─── Validation ──────────────────────────────────────────────────
export function validateJobInput(raw: unknown): CreateJobInput {
  if (typeof raw !== "object" || raw === null) throw new Error("Request body must be a JSON object");
  const b = raw as Record<string, unknown>;
  const topic = typeof b.topic === "string" ? b.topic.trim() : "";
  if (!topic) throw new Error("Topic is required");
  if (topic.length > 500) throw new Error("Topic too long (max 500 characters)");
  const language = b.language === "en" ? "en" : b.language === "ar" ? "ar" : undefined;
  if (!language) throw new Error("Language must be 'ar' or 'en'");
  const dur = Number(b.targetDurationSec ?? b.duration);
  if (!Number.isInteger(dur) || dur < 9 || dur > 300) throw new Error("Duration must be a whole number between 9 and 300 seconds");
  const format = b.format === "16:9" ? "16:9" : b.format === "1:1" ? "1:1" : b.format === "9:16" ? "9:16" : undefined;
  if (!format) throw new Error("Format must be '9:16', '16:9' or '1:1'");
  const clientToken = typeof b.clientToken === "string" && b.clientToken.length > 0 && b.clientToken.length <= 100 ? b.clientToken : undefined;
  return {
    topic, language, targetDurationSec: dur, format,
    skipRender: b.skipRender === true,
    clientToken,
  };
}

// ─── Job workspace ────────────────────────────────────────────────
export function jobWorkspace(id: string) {
  const dir = path.join(JOBS_ROOT, id);
  return {
    dir,
    dataDir: dir,
    imagesDir: path.join(dir, "images"),
    audioDir: path.join(dir, "audio"),
    renderDir: path.join(dir, "render"), // per-job Remotion entry (generated composition + public dir)
    publicDir: path.join(dir, "render", "public"),
    outputDir: path.join(dir, "out"),
    statusPath: path.join(dir, "status.json"),
    propsPath: path.join(dir, "render", "props.json"),
  };
}

function initWorkspace(id: string) {
  const ws = jobWorkspace(id);
  for (const d of [ws.dir, ws.imagesDir, ws.audioDir, ws.renderDir, ws.publicDir, ws.outputDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // Images and audio are served from the job's public dir so Remotion's staticFile()
  // resolves them: public/images/scene_N.jpg, public/audio/scene_N.mp3
  fs.mkdirSync(path.join(ws.publicDir, "images"), { recursive: true });
  fs.mkdirSync(path.join(ws.publicDir, "audio"), { recursive: true });
  return ws;
}

// ─── Job store ────────────────────────────────────────────────────
export class JobStore {
  // Multiple store instances exist per process (dashboard API + runner). Reads
  // re-sync from disk so every instance observes the latest persisted state;
  // writes are atomic renames. The index is small, so this is cheap.
  private jobs: Record<string, JobRecord> = {};

  private sync(): void {
    this.jobs = readIndex();
  }

  list(): JobRecord[] {
    this.sync();
    return Object.values(this.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): JobRecord | undefined {
    this.sync();
    return this.jobs[id];
  }

  create(input: CreateJobInput): JobRecord {
    this.sync();
    // Idempotency: same client token within 10 minutes returns the same job
    if (input.clientToken) {
      const cutoff = Date.now() - 10 * 60 * 1000;
      const existing = Object.values(this.jobs).find(
        j => j.clientToken === input.clientToken && new Date(j.createdAt).getTime() > cutoff
      );
      if (existing) return existing;
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const stages = {} as Record<StageName, StageRecord>;
    for (const s of ALL_STAGES) stages[s] = { status: "pending", attempts: 0 };
    if (input.skipRender) stages.render.status = "skipped";
    const job: JobRecord = {
      id, topic: input.topic, language: input.language,
      targetDurationSec: input.targetDurationSec, format: input.format,
      skipRender: !!input.skipRender,
      status: "queued", createdAt: now, updatedAt: now,
      stage: null, stages, clientToken: input.clientToken,
    };
    this.jobs[id] = job;
    initWorkspace(id);
    this.save();
    return job;
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord {
    this.sync();
    const job = this.jobs[id];
    if (!job) throw new Error(`Job ${id} not found`);
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return job;
  }

  updateStage(id: string, stage: StageName, patch: Partial<StageRecord>): JobRecord {
    this.sync();
    const job = this.jobs[id];
    if (!job) throw new Error(`Job ${id} not found`);
    Object.assign(job.stages[stage], patch);
    job.updatedAt = new Date().toISOString();
    this.save();
    return job;
  }

  /** Requeue for retry: failed stages become pending; completed stages are kept. */
  retry(id: string): JobRecord {
    this.sync();
    const job = this.jobs[id];
    if (!job) throw new Error(`Job ${id} not found`);
    if (job.status !== "failed") throw new Error("Only failed jobs can be retried");
    for (const s of ALL_STAGES) {
      const rec = job.stages[s];
      if (rec.status === "failed") {
        // one retry attempt allowed per stage per explicit user retry
        rec.status = "pending";
        rec.error = undefined;
      }
    }
    job.status = "queued";
    job.error = undefined;
    job.updatedAt = new Date().toISOString();
    this.save();
    return job;
  }

  cancel(id: string): JobRecord {
    this.sync();
    const job = this.jobs[id];
    if (!job) throw new Error(`Job ${id} not found`);
    if (job.status === "running" || job.status === "queued") {
      job.status = "canceled";
      job.updatedAt = new Date().toISOString();
      this.save();
    }
    return job;
  }

  private save(): void {
    // Prune very old completed jobs from the index (workspace files remain).
    // IMPORTANT: use the in-memory map, not list() — list() re-syncs from disk
    // and would discard pending mutations.
    const completed = Object.values(this.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter(j => j.status === "completed" || j.status === "failed");
    if (completed.length > MAX_COMPLETED_HISTORY) {
      const toDrop = new Set(completed.slice(MAX_COMPLETED_HISTORY).map(j => j.id));
      for (const id of toDrop) delete this.jobs[id];
    }
    writeIndexAtomic(this.jobs);
  }
}

// ─── Shared store singleton ───────────────────────────────────────
// The dashboard API and the runner must observe the same job records.
// All instances are disk-synced, but a single shared instance per process
// also removes the read-modify-write race between them.
let SHARED: JobStore | undefined;
export function sharedJobStore(): JobStore {
  if (!SHARED) SHARED = new JobStore();
  return SHARED;
}

// ─── Subprocess runner with timeout ───────────────────────────────
export interface RunResult { code: number; stdout: string; stderr: string }

export function runStageProcess(cmd: string, args: string[], opts: {
  cwd: string; timeoutMs: number; env?: Record<string, string>;
}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", d => { stdout += d; if (stdout.length > 500_000) stdout = stdout.slice(-250_000); });
    child.stderr.on("data", d => { stderr += d; if (stderr.length > 500_000) stderr = stderr.slice(-250_000); });
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", code => {
      clearTimeout(timer);
      if (killed) reject(new Error(`Stage timed out after ${opts.timeoutMs / 1000}s`));
      else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// ─── Bounded queue ────────────────────────────────────────────────
type Worker = () => Promise<void>;

export class BoundedQueue {
  private pending: Array<{ id: string; run: Worker }> = [];
  private active = 0;
  constructor(private concurrency = 1) {}

  get queuedCount() { return this.pending.length; }
  get activeCount() { return this.active; }

  submit(id: string, run: Worker): void {
    this.pending.push({ id, run });
    this.drain();
  }

  removeQueued(id: string): void {
    this.pending = this.pending.filter(p => p.id !== id);
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length) {
      const next = this.pending.shift()!;
      this.active++;
      next.run().finally(() => { this.active--; this.drain(); });
    }
  }
}
