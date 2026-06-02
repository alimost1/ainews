#!/usr/bin/env node
// Regenerate dark scene images at 768x1344 (9:16) with CF SDXL + strict black-image detection
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PROJECT = "/root/ianews";
const IMAGES = path.join(PROJECT, "public/images");
const DATA = path.join(PROJECT, "data");
require("dotenv").config({ path: path.join(PROJECT, ".env") });

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_IMAGE_MODEL = process.env.CF_IMAGE_MODEL || "@cf/stabilityai/stable-diffusion-xl-base-1.0";

const script = JSON.parse(fs.readFileSync(path.join(DATA, "script.json"), "utf-8"));

const MIN_BRIGHTNESS = 50;

console.log("Regenerating dark scenes at 768x1344 with:", CF_IMAGE_MODEL);
console.log("Min brightness threshold:", MIN_BRIGHTNESS);

function getBrightness(filePath) {
  try {
    const rawPath = "/tmp/_chk_bright.bin";
    execSync("ffmpeg -y -i \"" + filePath + "\" -frames:v 1 -f rawvideo -pix_fmt rgb24 \"" + rawPath + "\"", { timeout: 15000, stdio: "pipe" });
    const data = fs.readFileSync(rawPath);
    try { fs.unlinkSync(rawPath); } catch {}
    if (data.length < 300) return 0;
    const sample = data.slice(0, 3000);
    let sum = 0; for (let i = 0; i < sample.length; i++) sum += sample[i];
    return sum / sample.length;
  } catch (e) { return -1; }
}

function fmt(n) { return Math.round(n).toString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function generateImage(prompt, sceneNum) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + CF_IMAGE_MODEL;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log("  Scene " + sceneNum + " attempt " + attempt + "/5...");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Authorization": "Bearer " + CF_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt + ", photorealistic, professional photography, bright natural lighting, high detail, 8k resolution, vibrant colors",
          width: 768, height: 1344, num_steps: 20, guidance_scale: 8.0,
        }),
        timeout: 120000,
      });

      if (res.status === 429) { await sleep(attempt * 10000); continue; }
      if (!res.ok) { console.log("    HTTP " + res.status); await sleep(5000); continue; }

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 2000) { await sleep(3000); continue; }

      const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
      const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
      if (!isPng && !isJpeg) { await sleep(3000); continue; }

      const outPath = path.join(IMAGES, "scene_" + sceneNum + ".png");
      const tmpPath = outPath + ".tmp";
      fs.writeFileSync(tmpPath, buffer);

      const avg = getBrightness(tmpPath);
      console.log("    Brightness: " + fmt(avg) + (avg >= MIN_BRIGHTNESS ? " OK" : " DARK - retrying"));

      if (avg < MIN_BRIGHTNESS) {
        fs.unlinkSync(tmpPath);
        await sleep(3000);
        continue;
      }

      fs.renameSync(tmpPath, outPath);
      console.log("    Saved: " + fmt(buffer.length / 1024) + " KB");
      return outPath;

    } catch (e) {
      console.log("    Error: " + (e.message || "").substring(0, 80));
      await sleep(5000);
    }
  }
  return null;
}

async function main() {
  for (const scene of script.scenes) {
    const num = scene.scene_number;
    const existing = path.join(IMAGES, "scene_" + num + ".png");
    const avg = getBrightness(existing);

    if (avg >= MIN_BRIGHTNESS) {
      console.log("Scene " + num + ": brightness=" + fmt(avg) + " OK, skipping");
      continue;
    }

    console.log("\nScene " + num + ": brightness=" + fmt(avg) + " TOO DARK, regenerating...");
    const result = await generateImage(scene.visual_prompt, num);
    if (!result) console.log("  Scene " + num + " FAILED all attempts");
    await sleep(2000);
  }

  console.log("\nFinal status:");
  for (const s of script.scenes) {
    const p = path.join(IMAGES, "scene_" + s.scene_number + ".png");
    if (fs.existsSync(p)) {
      const sz = fs.statSync(p).size;
      const avg = getBrightness(p);
      console.log("  Scene " + s.scene_number + ": " + fmt(sz/1024) + "KB, brightness=" + fmt(avg));
    }
  }
}
main().catch(console.error);
