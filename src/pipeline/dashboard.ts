/**
 * dashboard.ts — HTTP API for the generation dashboard, mounted on the existing server.
 *
 * Endpoints (all JSON):
 *   POST /api/jobs            {topic, language, targetDurationSec, format, skipRender?, clientToken?}
 *   GET  /api/jobs            list jobs (history)
 *   GET  /api/jobs/:id        job detail incl. stages
 *   POST /api/jobs/:id/retry
 *   POST /api/jobs/:id/cancel
 *   GET  /api/jobs/:id/video  download the completed video
 *   GET  /api/config          supported providers/models + limits
 *   GET  /api/queue           queue stats
 *
 * Security: no tokens in responses; body size limited; paths restricted to job dirs.
 */
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { URL } from "url";
import { validateJobInput, sharedJobStore, jobWorkspace, ALL_STAGES, JobStore } from "../pipeline/jobs";
import { submitJob, resumeInterruptedJobs, queueStats } from "../pipeline/runner";

const store = sharedJobStore();
const MAX_BODY_BYTES = 32 * 1024;

// Provider/model matrix reflects ONLY what the code actually supports.
export function providerConfig() {
  return {
    languages: [
      { code: "ar", label: "العربية (Arabic)", rtl: true },
      { code: "en", label: "English", rtl: false },
    ],
    formats: [
      { code: "9:16", label: "عمودي 9:16 (Reels/Shorts)", width: 1080, height: 1920 },
      { code: "16:9", label: "أفقي 16:9 (YouTube)", width: 1920, height: 1080 },
      { code: "1:1", label: "مربع 1:1", width: 1080, height: 1080 },
    ],
    durationSec: { min: 9, max: 300 },
    providers: {
      researchAndScript: {
        id: "openrouter",
        label: "OpenRouter",
        model: process.env.OPENROUTER_MODEL || "openai/gpt-oss-120b:free",
        configured: !!process.env.OPENROUTER_API_KEY,
      },
      images: {
        id: "cloudflare-workers-ai",
        label: "Cloudflare Workers AI (fallbacks: Pollinations, Flickr, Wikimedia, picsum)",
        model: process.env.CF_IMAGE_MODEL || "@cf/lykon/dreamshaper-8-lcm",
        configured: !!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN),
      },
      narration: {
        id: "edge-tts",
        label: "Edge TTS (free, local)",
        model: "ar-SA-ZariyahNeural / en-US voices by mood",
        configured: true,
      },
      rendering: {
        id: "remotion",
        label: "Remotion",
        model: "4.0.240",
        configured: true,
      },
    },
    stages: ALL_STAGES,
  };
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Route handler; returns true if the request was handled. */
export async function handleDashboardApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;
  const m = req.method || "GET";

  if (m === "OPTIONS" && p.startsWith("/api/")) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }

  if (p === "/api/config" && m === "GET") { json(res, 200, providerConfig()); return true; }
  if (p === "/api/queue" && m === "GET") { json(res, 200, { ...queueStats() }); return true; }

  if (p === "/api/jobs" && m === "GET") {
    json(res, 200, { jobs: store.list().map(publicJob) });
    return true;
  }

  if (p === "/api/jobs" && m === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
      const input = validateJobInput(body);
      const job = store.create(input);
      submitJob(job.id);
      json(res, 201, { job: publicJob(job) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 400, { error: message });
    }
    return true;
  }

  const jobMatch = p.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)(\/[a-z]+)?$/);
  if (jobMatch) {
    const id = jobMatch[1];
    const action = jobMatch[2]; // undefined | /retry | /cancel | /video
    const job = store.get(id);
    if (!job) { json(res, 404, { error: "Job not found" }); return true; }

    if (!action && m === "GET") { json(res, 200, { job: publicJob(job) }); return true; }

    if (action === "/retry" && m === "POST") {
      try {
        const updated = store.retry(id);
        submitJob(id);
        json(res, 200, { job: publicJob(updated) });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (action === "/cancel" && m === "POST") {
      const updated = store.cancel(id);
      json(res, 200, { job: publicJob(updated) });
      return true;
    }

    if (action === "/video" && m === "GET") {
      if (!job.output || !fs.existsSync(job.output.videoPath)) {
        json(res, 404, { error: "Video not ready" });
        return true;
      }
      // Path is restricted to this job's own workspace output.
      const ws = jobWorkspace(id);
      const resolved = path.resolve(job.output.videoPath);
      if (!resolved.startsWith(path.resolve(ws.outputDir) + path.sep)) {
        json(res, 403, { error: "Forbidden" });
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": fs.statSync(resolved).size,
        "Content-Disposition": `attachment; filename="ianews-${id}.mp4"`,
      });
      fs.createReadStream(resolved).pipe(res);
      return true;
    }
  }

  return false;
}

/** Never expose internals: strip client tokens from public views. */
function publicJob(job: ReturnType<JobStore["get"]>) {
  if (!job) return job;
  const { clientToken, ...rest } = job;
  return rest;
}

export function initDashboard() {
  const resumed = resumeInterruptedJobs();
  return { resumed, store, queueStats };
}
