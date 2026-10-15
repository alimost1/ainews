/**
 * property-jobs.ts — Durable store + runner for property-presentation jobs.
 * Reuses the JobStore persistence pattern from jobs.ts with property-specific
 * stages: extract -> script(user-reviewed) -> voice -> avatar -> compose -> render.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { PropJobInput, PropStage } from "./property-presentation";
import { PROP_STAGES } from "./property-presentation";

export const PROP_JOBS_ROOT = path.resolve(__dirname, "../../data/prop-jobs");
const INDEX_PATH = process.env.IANEWS_PROP_INDEX || path.join(PROP_JOBS_ROOT, "index.json");
fs.mkdirSync(PROP_JOBS_ROOT, { recursive: true });

export type PropJobStatus = "draft" | "queued" | "running" | "completed" | "failed" | "canceled";

export interface PropStageRecord {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  providerRequestIds?: string[];
}

export interface PropJobRecord {
  id: string;
  status: PropJobStatus;
  createdAt: string;
  updatedAt: string;
  sourceUrl: string;
  language: "fr" | "ar" | "en";
  voiceId: string;
  narration: string;
  listing: PropJobInput["listing"];
  branding: PropJobInput["branding"];
  avatarProvided: boolean;
  editStyle?: import("./property-cinematic").EditStyle;
  motionModel?: import("./property-models").PropertyMotion;
  presenterVersion?: "greenscreen-v2";
  mode?: import("./property-presenter").ComposeMode;
  stages: Record<PropStage, PropStageRecord>;
  segments?: { text: string; audioSec?: number }[];
  actualDurationSec?: number;
  output?: { videoPath: string; bytes: number };
  error?: string;
  clientToken?: string;
}

function readIndex(): Record<string, PropJobRecord> {
  try {
    const jobs = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    for (const job of Object.values(jobs) as PropJobRecord[]) {
      // Stage-list migrations (never clobber completed/failed work):
      if ((job.stages as any).avatar && !job.stages.lipsync) {
        job.stages.lipsync = (job.stages as any).avatar; // old name of the Wan lip-sync stage
        delete (job.stages as any).avatar;
      }
      for (const s of ["motion", "presenter", "scenePrep", "lipsync"] as PropStage[]) {
        job.stages[s] ||= { status: "pending", attempts: 0 };
      }
    }
    return jobs;
  } catch { return {}; }
}

export function propJobDir(id: string) {
  return path.join(PROP_JOBS_ROOT, id);
}

export class PropJobStore {
  private jobs: Record<string, PropJobRecord> = {};

  private sync(): void { this.jobs = readIndex(); }
  private save(): void {
    const tmp = INDEX_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.jobs, null, 2));
    fs.renameSync(tmp, INDEX_PATH);
  }

  list(): PropJobRecord[] {
    this.sync();
    return Object.values(this.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): PropJobRecord | undefined {
    this.sync();
    return this.jobs[id];
  }

  /** Create a draft from extraction (before review). */
  createDraft(input: Omit<PropJobRecord, "status" | "createdAt" | "updatedAt" | "stages" | "id">): PropJobRecord {
    this.sync();
    if (input.clientToken) {
      const cutoff = Date.now() - 30 * 60 * 1000;
      const existing = Object.values(this.jobs).find(j => j.clientToken === input.clientToken && new Date(j.createdAt).getTime() > cutoff);
      if (existing) return existing;
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const stages = {} as Record<PropStage, PropStageRecord>;
    for (const s of PROP_STAGES) stages[s] = { status: "pending", attempts: 0 };
    stages.extract.status = "completed"; // extraction happened before draft creation
    const job: PropJobRecord = {
      id, status: "draft", createdAt: now, updatedAt: now,
      stages, ...input, presenterVersion: input.mode === "presenter" ? "greenscreen-v2" : undefined,
    };
    this.jobs[id] = job;
    fs.mkdirSync(propJobDir(id), { recursive: true });
    fs.mkdirSync(path.join(propJobDir(id), "render"), { recursive: true });
    this.save();
    return job;
  }

  update(id: string, patch: Partial<PropJobRecord>): PropJobRecord {
    this.sync();
    const job = this.jobs[id];
    if (!job) throw new Error(`Job ${id} not found`);
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return job;
  }

  updateStage(id: string, stage: PropStage, patch: Partial<PropStageRecord>): PropJobRecord {
    this.sync();
    const job = this.jobs[id];
    if (!job) throw new Error(`Job ${id} not found`);
    Object.assign(job.stages[stage], patch);
    job.updatedAt = new Date().toISOString();
    this.save();
    return job;
  }

  /** Queue a draft after review. Validates narrations and listing completeness. */
  submitForGeneration(id: string): PropJobRecord {
    this.sync();
    const job = this.jobs[id];
    if (!job) throw new Error(`Job ${id} not found`);
    if (job.status !== "draft" && job.status !== "failed") throw new Error("Only draft or failed jobs can be generated");
    if (!job.narration || job.narration.trim().length < 40) throw new Error("Narration is empty or too short");
    if (!job.listing.images.length) throw new Error("Select at least one property photo");
    job.status = "queued";
    job.error = undefined;
    for (const s of PROP_STAGES) {
      if (s === "extract") continue; // already completed at draft time
      const rec = job.stages[s];
      if (rec.status === "failed") { rec.status = "pending"; rec.error = undefined; }
    }
    this.save();
    return job;
  }

  cancel(id: string): PropJobRecord {
    this.sync();
    const job = this.jobs[id];
    if (!job) throw new Error(`Job ${id} not found`);
    if (job.status === "queued" || job.status === "running") {
      job.status = "canceled";
      this.save();
    }
    return job;
  }
}

export function publicPropJob(job: PropJobRecord) {
  const { clientToken, ...rest } = job;
  void clientToken;
  return rest;
}
