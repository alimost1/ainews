/**
 * shared.ts — Shared utilities for all agents
 * 
 * Provides:
 * - OpenRouter API client with retry logic
 * - File I/O helpers
 * - Logging utilities
 * - Environment config
 */

import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// ─── Config ─────────────────────────────────────────────────────
export const CONFIG = {
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openRouterModel: process.env.OPENROUTER_MODEL || "openai/gpt-oss-120b:free",
  videoWidth: parseInt(process.env.VIDEO_WIDTH || "1080", 10),
  videoHeight: parseInt(process.env.VIDEO_HEIGHT || "1920", 10),
  fps: parseInt(process.env.FPS || "30", 10),
  language: process.env.VIDEO_LANGUAGE || "ar",
  duration: parseInt(process.env.VIDEO_DURATION || "30", 10),
  projectRoot: path.resolve(__dirname, "../.."),
  // Workspace overrides: the job runner isolates each generation in its own
  // directory via these environment variables. Defaults preserve the
  // historical single-run layout.
  dataDir: process.env.IANEWS_DATA_DIR || path.resolve(__dirname, "../../data"),
  imagesDir: process.env.IANEWS_IMAGES_DIR || path.resolve(__dirname, "../../public/images"),
  audioDir: process.env.IANEWS_AUDIO_DIR || path.resolve(__dirname, "../../public/audio"),
  outputDir: process.env.IANEWS_OUTPUT_DIR || path.resolve(__dirname, "../../output"),
  editorDir: process.env.IANEWS_EDITOR_DIR || path.resolve(__dirname, "../"),
  providerLog: process.env.IANEWS_PROVIDER_LOG || "",
  // Cloudflare Workers AI
  cfAccountId: process.env.CF_ACCOUNT_ID || "",
  cfApiToken: process.env.CF_API_TOKEN || "",
  cfImageModel: process.env.CF_IMAGE_MODEL || "@cf/lykon/dreamshaper-8-lcm",
};

// Ensure directories exist
for (const dir of [CONFIG.dataDir, CONFIG.imagesDir, CONFIG.audioDir, CONFIG.outputDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Logger ──────────────────────────────────────────────────────
export const logger = {
  info: (msg: string) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[32m[OK]\x1b[0m   ${msg}`),
  warn: (msg: string) => console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
  error: (msg: string) => console.log(`\x1b[31m[ERR]\x1b[0m  ${msg}`),
  agent: (name: string, msg: string) => console.log(`\x1b[35m[${name}]\x1b[0m ${msg}`),
};

// ─── OpenRouter API ─────────────────────────────────────────────
export async function callOpenRouter(
  messages: Array<{ role: string; content: string }>,
  options: { maxRetries?: number; temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  const { maxRetries = 3, temperature = 0.7, maxTokens = 2048 } = options;

  if (!CONFIG.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY not set in .env file");
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`OpenRouter API call (attempt ${attempt}/${maxRetries})...`);

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${CONFIG.openRouterApiKey}`,
          "HTTP-Referer": "https://ianews.app",
          "X-Title": "iAnews Video Generator",
        },
        body: JSON.stringify({
          model: CONFIG.openRouterModel,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("Empty response from OpenRouter");
      }

      // Record the REAL provider request id for observability (never invent one).
      const requestId = data.id || data["x-openrouter-request-id"] || response.headers?.get?.("x-openrouter-request-id");
      if (requestId && CONFIG.providerLog) {
        try { fs.appendFileSync(CONFIG.providerLog, String(requestId) + "\n"); } catch { /* best-effort */ }
      }

      return content;
    } catch (err: any) {
      logger.warn(`Attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      // Exponential backoff
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw new Error("All OpenRouter retries exhausted");
}

// ─── File I/O ────────────────────────────────────────────────────
export function readJSON<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export function writeJSON(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

// ─── Helpers ────────────────────────────────────────────────────
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractJSON(text: string): any {
  // Try to extract JSON from markdown code blocks or raw text
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    return JSON.parse(codeBlockMatch[1]);
  }
  // Try to find the first { ... } block
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  // Try to find the first [ ... ] block
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    return JSON.parse(arrayMatch[0]);
  }
  throw new Error("No JSON found in text");
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);
}
