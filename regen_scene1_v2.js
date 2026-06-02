#!/usr/bin/env node
// Regenerate scene 1 at 768x1344 with bright prompt
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
const scene = script.scenes.find(s => s.scene_number === 1);

function getBrightness(filePath) {
  try {
    const rawPath = "/tmp/_chk.bin";
    execSync("ffmpeg -y -i \"" + filePath + "\" -frames:v 1 -f rawvideo -pix_fmt rgb24 \"" + rawPath + "\"", { timeout: 15000, stdio: "pipe" });
    const data = fs.readFileSync(rawPath); try { fs.unlinkSync(rawPath); } catch {}
    if (data.length < 300) return 0;
    let sum = 0; for (let i = 0; i < Math.min(3000,data.length); i++) sum += data[i];
    return sum / Math.min(3000,data.length);
  } catch (e) { return -1; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tryCF(prompt, num) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + CF_IMAGE_MODEL;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log("  CF SDXL attempt " + attempt + "...");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Authorization": "Bearer " + CF_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt, width: 768, height: 1344, num_steps: 20, guidance_scale: 8.0 }),
        timeout: 120000,
      });
      if (res.status === 429) { await sleep(attempt * 10000); continue; }
      if (!res.ok) { console.log("    HTTP " + res.status); await sleep(5000); continue; }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 2000) { await sleep(3000); continue; }
      const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
      const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
      if (!isPng && !isJpeg) { await sleep(3000); continue; }
      return buffer;
    } catch (e) { await sleep(5000); }
  }
  return null;
}

async function tryPollinations(prompt, num) {
  const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) + "?width=768&height=1344&nologo=true&seed=" + (100 + num) + "&model=flux-schnell";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log("  Pollinations attempt " + attempt + "...");
      const res = await fetch(url, { timeout: 60000, redirect: "follow" });
      if (!res.ok) { console.log("    HTTP " + res.status); await sleep(3000); continue; }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 2000) { console.log("    Too small: " + buffer.length); await sleep(3000); continue; }
      const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
      const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
      if (!isJpeg && !isPng) { await sleep(3000); continue; }
      return buffer;
    } catch (e) { await sleep(3000); }
  }
  return null;
}

async function main() {
  // Bright, colorful prompt for scene 1
  const brightPrompt = "A futuristic laboratory desk with a holographic screen displaying glowing physics equations, bright neon blue and purple lights, vibrant colors, cinematic lighting, high detail, photorealistic, 8k resolution";

  // Try CF SDXL first
  let buf = await tryCF(brightPrompt, 1);
  if (buf) {
    const tmpPath = "/tmp/scene1_cf.png";
    fs.writeFileSync(tmpPath, buf);
    const avg = getBrightness(tmpPath);
    const dims = execSync("ffprobe -v quiet -show_entries stream=width,height -of csv=p=0 \"" + tmpPath + "\"", {encoding:"utf8"}).trim();
    console.log("  CF result: brightness=" + Math.round(avg) + ", dims=" + dims + ", size=" + Math.round(buf.length/1024) + "KB");
    if (avg >= 50 && buf.length > 50000) {
      fs.copyFileSync(tmpPath, path.join(IMAGES, "scene_1.png"));
      console.log("  Saved as scene_1.png");
      return;
    }
    console.log("  CF result too dark or small, trying Pollinations...");
  }

  // Try Pollinations
  buf = await tryPollinations(brightPrompt, 1);
  if (buf) {
    const tmpPath = "/tmp/scene1_poll.jpg";
    fs.writeFileSync(tmpPath, buf);
    const avg = getBrightness(tmpPath);
    const dims = execSync("ffprobe -v quiet -show_entries stream=width,height -of csv=p=0 \"" + tmpPath + "\"", {encoding:"utf8"}).trim();
    console.log("  Pollinations result: brightness=" + Math.round(avg) + ", dims=" + dims + ", size=" + Math.round(buf.length/1024) + "KB");
    if (avg >= 50) {
      // Convert to PNG for consistency
      execSync("ffmpeg -y -i \"" + tmpPath + "\" \"" + path.join(IMAGES, "scene_1.png") + "\"", {timeout: 15000, stdio: "pipe"});
      console.log("  Saved as scene_1.png");
      return;
    }
  }

  console.log("  All attempts failed for scene 1");
}

main().catch(console.error);
