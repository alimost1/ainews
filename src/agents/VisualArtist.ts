/**
 * VisualArtist.ts — VisualArtist Agent
 * 
 * Reads script.json, generates images via:
 * 1. Pollinations.ai (free AI image gen, prompt-matched, no key)
 * 2. Flickr (real photos, keyword-matched, no key)
 * 3. Wikimedia Commons (fallback)
 * 4. picsum.photos (last resort)
 * 
 * Usage: npx tsx src/agents/VisualArtist.ts
 */

import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import { logger, CONFIG, readJSON, writeJSON, sleep } from "./shared";
import type { Script, Scene } from "../types";

// ─── Cloudflare Workers AI Image Generation ──────────────────────

// ─── Photorealistic prompt enhancement ───────────────────────────

const NEGATIVE_PROMPT = "illustration, drawing, painting, cartoon, sketch, inked, anime, vector art, clipart, crayon, watercolor, doodle, comic, manga, stylized, unrealistic, plastic, blurry, low quality, deformed, ugly, bad anatomy, bad proportions, extra limbs, disfigured, out of frame, cropped, worst quality, normal quality, oversaturated, undersaturated, overexposed, underexposed, grayscale, monochrome, logo, watermark, text, signature, frame, border";

function enhancePrompt(prompt: string): string {
  // If prompt already has photogenic terms, don't over-enhance
  const hasPhotogenicTerms = /photo|photograph|dslr|camera|lens|cinematic|studio|8k|hd|macro|bokeh|raw/i.test(prompt);
  
  if (hasPhotogenicTerms) {
    return prompt;
  }

  return `${prompt}, photorealistic, professional photography, DSLR camera, sharp focus, natural lighting, high detail, realistic textures, 8k resolution`;
}

async function fetchCloudflareAI(prompt: string, sceneNumber: number): Promise<Buffer | null> {
  if (!CONFIG.cfAccountId || !CONFIG.cfApiToken) {
    logger.warn("Cloudflare AI: CF_ACCOUNT_ID or CF_API_TOKEN not set, skipping");
    return null;
  }

  // Skip placeholder/account-id
  if (CONFIG.cfAccountId === "your_cloudflare_account_id_here") {
    logger.warn("Cloudflare AI: placeholder CF_ACCOUNT_ID, update .env with real account ID");
    return null;
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${CONFIG.cfAccountId}/ai/run/${CONFIG.cfImageModel}`;

  // Model-specific step limits (Cloudflare Workers AI constraints)
  const modelMaxSteps = CONFIG.cfImageModel.includes('flux-1') ? 8
    : CONFIG.cfImageModel.includes('dreamshaper') ? 20
    : CONFIG.cfImageModel.includes('lightning') ? 8
    : 20; // SDXL and others default to 20
  const numSteps = Math.min(CONFIG.cfImageModel.includes('flux-1') ? 8 : 30, modelMaxSteps);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const enhancedPrompt = enhancePrompt(prompt);
      logger.agent("VisualArtist", `Scene ${sceneNumber} via Cloudflare AI (${CONFIG.cfImageModel}, ${numSteps} steps, attempt ${attempt}/3)...`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${CONFIG.cfApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: enhancedPrompt,
          negative_prompt: NEGATIVE_PROMPT,
          width: CONFIG.videoWidth,
          height: CONFIG.videoHeight,
          num_steps: numSteps,
          guidance_scale: CONFIG.cfImageModel.includes('flux-1') ? 7.5 : 8.0,
        }),
        timeout: 120000,
      });

      if (response.status === 401 || response.status === 403) {
        const errText = await response.text();
        logger.error(`Cloudflare AI: auth failed (${response.status}) — ${errText.substring(0, 300)}`);
        return null;
      }

      if (response.status === 429) {
        logger.warn(`Scene ${sceneNumber}: CF rate limit, waiting ${attempt * 10}s...`);
        await sleep(attempt * 10000);
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        logger.warn(`Scene ${sceneNumber} CF AI attempt ${attempt}: HTTP ${response.status} — ${errText.substring(0, 200)}`);
        // If num_steps too high, retry with fewer steps
        if (response.status === 400 && errText.includes("num_steps") && numSteps > 4) {
          const reducedSteps = Math.max(4, numSteps - 4);
          logger.info(`Scene ${sceneNumber}: reducing steps to ${reducedSteps} and retrying...`);
          const response2 = await fetch(url, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${CONFIG.cfApiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              prompt: enhancedPrompt,
              negative_prompt: NEGATIVE_PROMPT,
              width: CONFIG.videoWidth,
              height: CONFIG.videoHeight,
              num_steps: reducedSteps,
              guidance_scale: 8.0,
            }),
            timeout: 120000,
          });
          if (response2.ok) {
            const buffer = Buffer.from(await response2.arrayBuffer());
            if (buffer.length > 2000) {
              const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
              const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
              if (isPng || isJpeg) {
                logger.success(`Scene ${sceneNumber} CF AI image (reduced steps): ${Math.round(buffer.length / 1024)} KB`);
                return buffer;
              }
              // Try JSON parse for FLUX
              try {
                const j = JSON.parse(buffer.toString('utf-8'));
                const b64 = j?.result?.image || j?.image;
                if (b64 && typeof b64 === 'string') {
                  const imgBuf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
                  if (imgBuf.length > 2000) {
                    logger.success(`Scene ${sceneNumber} CF AI image (from JSON, reduced steps): ${Math.round(imgBuf.length / 1024)} KB`);
                    return imgBuf;
                  }
                }
              } catch { /* not JSON */ }
            }
          }
        }
        // If negative_prompt not supported, retry without it
        if (response.status === 400 && errText.includes("negative_prompt") && attempt < 3) {
          logger.info(`Scene ${sceneNumber}: CF model doesn't support negative_prompt, retrying without it...`);
          const response3 = await fetch(url, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${CONFIG.cfApiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              prompt: enhancedPrompt,
              width: CONFIG.videoWidth,
              height: CONFIG.videoHeight,
              num_steps: numSteps,
              guidance_scale: CONFIG.cfImageModel.includes('flux-1') ? 7.5 : 8.0,
            }),
            timeout: 120000,
          });
          if (response3.ok) {
            const buffer = Buffer.from(await response3.arrayBuffer());
            if (buffer.length > 2000) {
              const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
              const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
              if (isPng || isJpeg) {
                logger.success(`Scene ${sceneNumber} CF AI image (no neg_prompt): ${Math.round(buffer.length / 1024)} KB`);
                return buffer;
              }
              // Try JSON parse for FLUX
              try {
                const j = JSON.parse(buffer.toString('utf-8'));
                const b64 = j?.result?.image || j?.image;
                if (b64 && typeof b64 === 'string') {
                  const imgBuf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
                  if (imgBuf.length > 2000) {
                    logger.success(`Scene ${sceneNumber} CF AI image (JSON, no neg_prompt): ${Math.round(imgBuf.length / 1024)} KB`);
                    return imgBuf;
                  }
                }
              } catch { /* not JSON */ }
            }
          }
        }
        if (attempt < 3) await sleep(attempt * 5000);
        continue;
      }

      // CF Workers AI returns image as raw bytes — PNG or JPEG
      const contentType = response.headers.get("content-type") || "";
      const buffer = Buffer.from(await response.arrayBuffer());

      if (buffer.length < 2000) {
        logger.warn(`Scene ${sceneNumber} CF AI: response too small (${buffer.length} bytes)`);
        if (attempt < 3) await sleep(attempt * 3000);
        continue;
      }

      // Check for PNG magic bytes or JPEG
      const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
      const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;

      if (isPng || isJpeg) {
        logger.success(`Scene ${sceneNumber} CF AI image (${isPng ? 'PNG' : 'JPEG'}): ${Math.round(buffer.length / 1024)} KB`);
        return buffer;
      }

      // Some CF models (FLUX) return JSON with base64 image
      if (contentType.includes("json") || (!isPng && !isJpeg)) {
        try {
          const data = JSON.parse(buffer.toString("utf-8")) as any;
          const b64 = data?.result?.image || data?.image || data?.images?.[0] || data?.data?.[0];
          if (b64 && typeof b64 === "string") {
            const imgBuf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), "base64");
            if (imgBuf.length > 2000) {
              logger.success(`Scene ${sceneNumber} CF AI image (from JSON): ${Math.round(imgBuf.length / 1024)} KB`);
              return imgBuf;
            }
          }
        } catch { /* not JSON */ }
      }

      logger.warn(`Scene ${sceneNumber} CF AI: unrecognized format (content-type: ${contentType}, ${buffer.length} bytes)`);
      if (attempt < 3) await sleep(attempt * 3000);

    } catch (err: any) {
      logger.warn(`Scene ${sceneNumber} CF AI attempt ${attempt}: ${err.message?.substring(0, 60)}`);
      if (attempt < 3) await sleep(attempt * 5000);
    }
  }

  return null;
}

// ─── Keyword extraction from visual prompts ─────────────────────

function extractKeywords(prompt: string): string[] {
  const stopWords = new Set([
    "a", "an", "the", "with", "and", "or", "of", "in", "on", "at", "to", "for",
    "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "may", "might",
    "this", "that", "these", "those", "it", "its", "from", "by", "as", "into",
    "through", "during", "before", "after", "above", "below", "between", "out",
    "off", "over", "under", "again", "further", "then", "once", "here", "there",
    "when", "where", "why", "how", "all", "each", "every", "both", "few", "more",
    "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same",
    "so", "than", "too", "very", "can", "just", "don", "should", "now", "showing",
    "shows", "show", "depicting", "depicts", "featuring", "features", "image",
    "picture", "photo", "scene", "view", "close-up", "wide", "shot", "angle",
    "background", "foreground", "left", "right", "top", "bottom", "center",
    "bright", "dark", "colorful", "vibrant", "detailed", "cinematic", "professional",
    "high", "quality", "4k", "8k", "hd", "ultra", "realistic", "stylized",
    "animation", "animated", "single", "three", "floating", "split", "overlay",
    "glowing", "glow", "panel", "panels", "icons", "icon",
  ]);

  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));

  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      keywords.push(w);
    }
  }

  return keywords.slice(0, 5);
}

// ─── Strategy 1: Pollinations.ai (AI-generated, prompt-matched) ──

async function fetchPollinations(prompt: string, sceneNumber: number): Promise<Buffer | null> {
  // Use full prompt for best results (truncate to 200 chars to avoid URL limits)
  const shortPrompt = prompt.length > 200 ? prompt.substring(0, 200).trim() : prompt;
  const encodedPrompt = encodeURIComponent(shortPrompt);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${CONFIG.videoWidth}&height=${CONFIG.videoHeight}&nologo=true&seed=${42 + sceneNumber}&model=flux-schnell`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logger.agent("VisualArtist", `Scene ${sceneNumber} via Pollinations (attempt ${attempt}/3)...`);

      const response = await fetch(url, { timeout: 60000, redirect: "follow" });

      if (response.status === 402) {
        logger.warn(`Scene ${sceneNumber}: Pollinations rate-limited, waiting ${attempt * 5}s...`);
        await sleep(attempt * 5000);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      if (buffer.length < 1000) throw new Error("Too small");
      if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) throw new Error("Not JPEG");

      return buffer;

    } catch (err: any) {
      logger.warn(`Scene ${sceneNumber} Pollinations attempt ${attempt}: ${err.message?.substring(0, 60)}`);
      if (attempt < 3) await sleep(attempt * 3000);
    }
  }

  return null;
}

// ─── Strategy 2: Flickr (real photos, keyword-matched) ──────────

async function fetchFlickr(keywords: string[], sceneNumber: number): Promise<Buffer | null> {
  const tagString = keywords.slice(0, 3).join(",");
  const url = `https://www.flickr.com/services/feeds/photos_public.gne?tags=${encodeURIComponent(tagString)}&format=json&nojsoncallback=1&per_page=10`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logger.agent("VisualArtist", `Scene ${sceneNumber} via Flickr (attempt ${attempt}/3)...`);

      const res = await fetch(url, { timeout: 15000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as any;
      const items = data?.items || [];

      for (const item of items) {
        const mediaUrl = item?.media?.m;
        if (!mediaUrl) continue;
        const largeUrl = mediaUrl.replace("_m.jpg", "_b.jpg");

        try {
          const imgRes = await fetch(largeUrl, { timeout: 15000, redirect: "follow" });
          if (!imgRes.ok) continue;
          const buf = Buffer.from(await imgRes.arrayBuffer());
          if (buf.length > 5000 && buf[0] === 0xFF && buf[1] === 0xD8) return buf;
        } catch { continue; }
      }

      return null;

    } catch (err: any) {
      logger.warn(`Scene ${sceneNumber} Flickr attempt ${attempt}: ${err.message?.substring(0, 60)}`);
      if (attempt < 3) await sleep(attempt * 2000);
    }
  }

  return null;
}

// ─── Strategy 3: Wikimedia Commons (free knowledge base) ─────────

async function fetchWikimedia(keywords: string[], sceneNumber: number): Promise<Buffer | null> {
  const searchQuery = keywords.slice(0, 3).join("+");
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(searchQuery)}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url&iiurlwidth=1080&format=json`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      logger.agent("VisualArtist", `Scene ${sceneNumber} via Wikimedia (attempt ${attempt}/2)...`);

      const res = await fetch(url, { timeout: 15000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as any;
      const pages = data?.query?.pages;
      if (!pages) return null;

      for (const item of Object.values(pages) as any[]) {
        const title = item?.title || "";
        if (/\.(svg|gif|pdf|webm|ogg|ogv)$/i.test(title)) continue;
        const thumbUrl = item?.imageinfo?.[0]?.thumburl;
        if (!thumbUrl) continue;

        try {
          const imgRes = await fetch(thumbUrl, { timeout: 15000, redirect: "follow" });
          if (!imgRes.ok) continue;
          const buf = Buffer.from(await imgRes.arrayBuffer());
          if (buf.length > 5000 && buf[0] === 0xFF && buf[1] === 0xD8) return buf;
        } catch { continue; }
      }

      return null;

    } catch (err: any) {
      if (attempt < 2) await sleep(2000);
    }
  }

  return null;
}

// ─── Strategy 4: picsum fallback (seeded) ────────────────────────

async function fetchPicsum(prompt: string, sceneNumber: number): Promise<Buffer> {
  const seed = encodeURIComponent(`scene-${sceneNumber}-${prompt.substring(0, 40)}`);
  const url = `https://picsum.photos/seed/${seed}/${CONFIG.videoWidth}/${CONFIG.videoHeight}.jpg`;
  const res = await fetch(url, { timeout: 15000, headers: { "User-Agent": "iAnews/1.0" }, redirect: "follow" });
  if (!res.ok) throw new Error(`picsum HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── Main image generation ───────────────────────────────────────

async function generateSceneImage(prompt: string, sceneNumber: number): Promise<string> {
  const outputPath = path.join(CONFIG.imagesDir, `scene_${sceneNumber}.jpg`);
  const keywords = extractKeywords(prompt);

  logger.agent("VisualArtist", `Scene ${sceneNumber} keywords: ${keywords.join(", ")}`);

  // Strategy 0: Cloudflare Workers AI (best quality, real AI image gen)
  const cfBuffer = await fetchCloudflareAI(prompt, sceneNumber);
  if (cfBuffer) {
    fs.writeFileSync(outputPath, cfBuffer);
    logger.success(`Scene ${sceneNumber} AI image saved (${Math.round(cfBuffer.length / 1024)} KB) [Cloudflare AI]`);
    // Black-image detection
    try {
      const { execSync } = require("child_process");
      const rawPath = "/tmp/_check_black.bin";
      execSync(`ffmpeg -y -i "${outputPath}" -frames:v 1 -f rawvideo -pix_fmt rgb24 "${rawPath}"`, { timeout: 10000, stdio: "pipe" });
      const raw = fs.readFileSync(rawPath);
      const sample = raw.slice(0, 3000);
      let sum = 0; for (let i = 0; i < sample.length; i++) sum += sample[i];
      const avg = sum / sample.length;
      try { fs.unlinkSync(rawPath); } catch {}
      if (avg < 50) {
        logger.warn(`Scene ${sceneNumber}: BLACK IMAGE detected (avg=${avg.toFixed(1)}), discarding CF result`);
        fs.unlinkSync(outputPath);
        // fall through to Pollinations
      } else {
        logger.success(`Scene ${sceneNumber}: black check passed (avg=${avg.toFixed(1)})`);
        return outputPath;
      }
    } catch (e: any) { logger.warn(`Black check failed: ${e.message?.substring(0,40)}`); }
  }

  // Strategy 1: Pollinations (AI-generated, full prompt matched)
  const pollBuffer = await fetchPollinations(prompt, sceneNumber);
  if (pollBuffer) {
    fs.writeFileSync(outputPath, pollBuffer);
    logger.success(`Scene ${sceneNumber} AI image saved (${Math.round(pollBuffer.length / 1024)} KB) [Pollinations]`);
    return outputPath;
  }

  // Strategy 2: Flickr (real photos, keyword-matched)
  const flickrBuf = await fetchFlickr(keywords, sceneNumber);
  if (flickrBuf) {
    fs.writeFileSync(outputPath, flickrBuf);
    logger.success(`Scene ${sceneNumber} image saved (${Math.round(flickrBuf.length / 1024)} KB) [Flickr]`);
    return outputPath;
  }

  // Strategy 3: Wikimedia Commons
  const wikiBuf = await fetchWikimedia(keywords, sceneNumber);
  if (wikiBuf) {
    fs.writeFileSync(outputPath, wikiBuf);
    logger.success(`Scene ${sceneNumber} image saved (${Math.round(wikiBuf.length / 1024)} KB) [Wikimedia]`);
    return outputPath;
  }

  // Strategy 4: picsum fallback
  logger.info(`Scene ${sceneNumber}: falling back to picsum.photos`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const buf = await fetchPicsum(prompt, sceneNumber);
      if (buf.length >= 1000 && buf[0] === 0xFF && buf[1] === 0xD8) {
        fs.writeFileSync(outputPath, buf);
        logger.success(`Scene ${sceneNumber} image saved (${Math.round(buf.length / 1024)} KB) [picsum]`);
        return outputPath;
      }
    } catch (err: any) {
      if (attempt < 3) await sleep(attempt * 2000);
    }
  }

  generatePlaceholder(outputPath, sceneNumber, prompt);
  return outputPath;
}

// ─── Placeholder (gradient) ──────────────────────────────────────

function generatePlaceholder(outputPath: string, sceneNumber: number, prompt: string): void {
  const safePrompt = prompt.replace(/[<>&"']/g, "").substring(0, 50);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CONFIG.videoWidth}" height="${CONFIG.videoHeight}">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#0f0c29"/>
        <stop offset="50%" style="stop-color:#302b63"/>
        <stop offset="100%" style="stop-color:#24243e"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <text x="50%" y="42%" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-size="52" font-family="sans-serif" font-weight="bold">Scene ${sceneNumber}</text>
    <text x="50%" y="50%" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="28" font-family="sans-serif">${safePrompt}...</text>
    <rect x="${CONFIG.videoWidth * 0.1}" y="${CONFIG.videoHeight * 0.85}" width="${CONFIG.videoWidth * 0.8}" height="4" rx="2" fill="rgba(31,74,191,0.6)"/>
  </svg>`;

  fs.writeFileSync(outputPath, svg);
  logger.warn(`Scene ${sceneNumber}: gradient placeholder`);
}

// ─── Generate all images ─────────────────────────────────────────

async function generateAllImages(script: Script): Promise<Script> {
  logger.agent("VisualArtist", `Generating ${script.scenes.length} scene images (${CONFIG.videoWidth}x${CONFIG.videoHeight})...`);

  const updatedScenes: Scene[] = [];
  for (const scene of script.scenes) {
    const imagePath = await generateSceneImage(scene.visual_prompt, scene.scene_number);
    const updatedScene = { ...scene, image_path: imagePath };
    updatedScenes.push(updatedScene);

    if (scene.scene_number < script.scenes.length) {
      await sleep(300); // polite delay between scenes
    }
  }

  return { ...script, scenes: updatedScenes as any };
}

// ─── Main VisualArtist function ──────────────────────────────────

export async function runVisualArtist(): Promise<Script> {
  logger.agent("VisualArtist", "🎨 Starting VisualArtist Agent...");

  const scriptPath = path.join(CONFIG.dataDir, "script.json");
  let script: Script;

  try {
    script = readJSON<Script>(scriptPath);
  } catch {
    throw new Error(`${scriptPath} not found. Run ScriptWriter first.`);
  }

  script = await generateAllImages(script);
  writeJSON(scriptPath, script);

  const realImages = script.scenes.filter((s: any) => {
    const p = s.image_path || "";
    if (!fs.existsSync(p)) return false;
    const buf = fs.readFileSync(p);
    // Accept both JPEG and PNG (Cloudflare AI returns PNG)
    const isJpeg = buf.length > 1000 && buf[0] === 0xFF && buf[1] === 0xD8;
    const isPng = buf.length > 1000 && buf[0] === 0x89 && buf[1] === 0x50;
    return isJpeg || isPng;
  }).length;

  logger.success(`Images done: ${realImages}/${script.scenes.length} real, ${script.scenes.length - realImages} placeholders`);
  return script;
}

// CLI
if (require.main === module) {
  runVisualArtist()
    .then(() => process.exit(0))
    .catch((err) => { logger.error(err.message); process.exit(1); });
}
