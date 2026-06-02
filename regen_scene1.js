#!/usr/bin/env node
// Regenerate scene 1 with Pollinations (SDXL keeps returning dark images for this prompt)
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PROJECT = "/root/ianews";
const IMAGES = path.join(PROJECT, "public/images");
const DATA = path.join(PROJECT, "data");
require("dotenv").config({ path: path.join(PROJECT, ".env") });

const script = JSON.parse(fs.readFileSync(path.join(DATA, "script.json"), "utf-8"));
const scene = script.scenes.find(s => s.scene_number === 1);

console.log("Regenerating Scene 1 with Pollinations.ai...");
console.log("Prompt:", scene.visual_prompt);

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPollinations(prompt, sceneNum) {
  const shortPrompt = prompt.length > 200 ? prompt.substring(0, 200).trim() : prompt;
  const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(shortPrompt) + "?width=768&height=1344&nologo=true&seed=" + (42 + sceneNum) + "&model=flux-schnell";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log("  Pollinations attempt " + attempt + "/3...");
      const res = await fetch(url, { timeout: 60000, redirect: "follow" });
      if (!res.ok) { console.log("    HTTP " + res.status); await sleep(3000); continue; }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 2000) { console.log("    Too small: " + buffer.length); await sleep(3000); continue; }
      const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
      const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
      if (!isJpeg && !isPng) { console.log("    Not an image"); await sleep(3000); continue; }
      return buffer;
    } catch (e) {
      console.log("    Error: " + (e.message || "").substring(0, 60));
      await sleep(3000);
    }
  }
  return null;
}

async function main() {
  // Try Pollinations first (better for bright/colorful prompts)
  const pollBuf = await fetchPollinations(scene.visual_prompt, 1);
  if (pollBuf) {
    const outPath = path.join(IMAGES, "scene_1_pollinations.jpg");
    fs.writeFileSync(outPath, pollBuf);
    const avg = getBrightness(outPath);
    console.log("  Pollinations: brightness=" + Math.round(avg) + ", size=" + Math.round(pollBuf.length/1024) + "KB");
    if (avg >= 50) {
      // Replace the dark CF image
      const finalPath = path.join(IMAGES, "scene_1.png");
      fs.copyFileSync(outPath, finalPath.replace(".png", ".jpg"));
      console.log("  Replaced scene_1 with Pollinations version");
    } else {
      console.log("  Still dark, trying with enhanced prompt...");
    }
  }

  // Final check
  const finalPng = path.join(IMAGES, "scene_1.png");
  const finalJpg = path.join(IMAGES, "scene_1.jpg");
  if (fs.existsSync(finalJpg)) {
    console.log("Scene 1: " + Math.round(fs.statSync(finalJpg).size/1024) + "KB, brightness=" + Math.round(getBrightness(finalJpg)));
  } else if (fs.existsSync(finalPng)) {
    console.log("Scene 1: " + Math.round(fs.statSync(finalPng).size/1024) + "KB, brightness=" + Math.round(getBrightness(finalPng)));
  }
}
main().catch(console.error);
