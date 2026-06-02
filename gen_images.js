#!/usr/bin/env node
// Quick SDXL image regen for new script
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
const CF_IMAGE_MODEL = process.env.CF_IMAGE_MODEL;

const script = JSON.parse(fs.readFileSync(path.join(DATA, "script.json"), "utf-8"));

console.log("🎨 SDXL image generation for new script:", script.topic);

function isBlackImage(filePath) {
  try {
    const rawPath = "/tmp/_check_black.bin";
    execSync(`ffmpeg -y -i "${filePath}" -frames:v 1 -f rawvideo -pix_fmt rgb24 "${rawPath}"`, { timeout: 10000, stdio: "pipe" });
    const data = fs.readFileSync(rawPath);
    if (data.length < 300) return true;
    const sample = data.slice(0, 3000);
    let sum = 0; for (let i = 0; i < sample.length; i++) sum += sample[i];
    const avg = sum / sample.length;
    try { fs.unlinkSync(rawPath); } catch {}
    console.log(`  Black check: avg_pixel=${avg.toFixed(1)} ${avg < 10 ? "⚠️ BLACK" : "✅ OK"}`);
    return avg < 10;
  } catch (e) { return false; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function generate(prompt, num) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_IMAGE_MODEL}`;
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`Scene ${num}: CF SDXL (attempt ${attempt}/3)...`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, width: 768, height: 1344, num_steps: 20, guidance_scale: 8.0 }),
        timeout: 120000,
      });

      if (res.status === 429) { console.log("  Rate limited, waiting..."); await sleep(15000); continue; }
      if (!res.ok) { console.log(`  HTTP ${res.status}`); await sleep(5000); continue; }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2000) { console.log(`  Too small: ${buf.length}`); await sleep(3000); continue; }

      const out = path.join(IMAGES, `scene_${num}.png`);
      fs.writeFileSync(out, buf);
      console.log(`  Saved: ${(buf.length/1024).toFixed(0)} KB`);

      if (isBlackImage(out)) {
        console.log("  ⚠️ BLACK — retrying...");
        fs.unlinkSync(out);
        await sleep(5000);
        continue;
      }

      // Verify dims
      const dims = execSync(`ffprobe -v quiet -show_entries stream=width,height -of csv=p=0 "${out}"`, {encoding:"utf8"}).trim();
      console.log(`  ✅ Scene ${num}: ${dims}`);
      return out;

    } catch (e) {
      console.log(`  Error: ${e.message?.substring(0,60)}`);
      await sleep(5000);
    }
  }
  return null;
}

async function main() {
  for (const scene of script.scenes) {
    const num = scene.scene_number;
    const p = scene.visual_prompt + ", photorealistic, professional photography, sharp focus, natural lighting, high detail, 8k resolution";
    console.log(`\n📸 Scene ${num}: ${p.substring(0,70)}`);
    
    const r = await generate(p, num);
    if (!r) console.log(`  ✗ Scene ${num} failed`);
    await sleep(2000);
  }
  
  console.log("\n✅ Images done!");
  for (const s of script.scenes) {
    const p = path.join(IMAGES, `scene_${s.scene_number}.png`);
    if (fs.existsSync(p)) {
      const sz = fs.statSync(p).size;
      const dims = execSync(`ffprobe -v quiet -show_entries stream=width,height -of csv=p=0 "${p}"`, {encoding:"utf8"}).trim();
      console.log(`  Scene ${s.scene_number}: ${(sz/1024).toFixed(0)} KB, ${dims}`);
    } else {
      console.log(`  Scene ${s.scene_number}: MISSING`);
    }
  }
}
main().catch(console.error);
