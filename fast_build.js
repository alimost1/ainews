#!/usr/bin/env node
// fast_build.js — Optimized for speed
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT = "/root/ianews";
const IMAGES = path.join(PROJECT, "public/images");
const AUDIO = path.join(PROJECT, "public/audio");
const OUTPUT = path.join(PROJECT, "output");
const CONCAT_LIST = path.join(PROJECT, "concat_list.txt");
const FPS = 30;

if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

const script = JSON.parse(fs.readFileSync(path.join(PROJECT, "data/script.json"), "utf-8"));
const SEGMENTS = [];
let totalDuration = 0;

console.log(` Fast Build: ${script.topic}\n`);

for (const scene of script.scenes) {
  const num = scene.scene_number;
  let imgPath = path.join(IMAGES, `scene_${num}.jpg`);
  if (!fs.existsSync(imgPath)) imgPath = path.join(IMAGES, `scene_${num}.png`);
  const audioPath = path.join(AUDIO, `scene_${num}.mp3`);
  const segOut = path.join(OUTPUT, `segment_${num}.mp4`);

  let audioDuration;
  try {
    const d = execFileSync("ffprobe", ["-v","quiet","-show_entries","format=duration","-of","csv=p=0", audioPath], {encoding:"utf8",timeout:8000});
    audioDuration = parseFloat(d.trim());
  } catch { audioDuration = scene.duration_seconds || 7; }

  const segDur = Math.round((audioDuration + 0.2) * 100) / 100;
  const frames = Math.round(segDur * FPS);

  console.log(`Scene ${num}: ${audioDuration.toFixed(1)}s → ${segDur}s @ ${frames}f`);

  execFileSync("ffmpeg", [
    "-y", "-loop", "1", "-i", imgPath,
    "-i", audioPath,
    "-vf", `scale=576:1024:force_original_aspect_ratio=increase,crop=576:1024,format=yuv420p`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    "-c:a", "aac", "-b:a", "64k",
    "-r", String(FPS),
    "-t", String(segDur),
    "-shortest",
    "-movflags", "+faststart",
    segOut
  ], { timeout: 60000, stdio: "pipe" });

  const sz = Math.round(fs.statSync(segOut).size / 1024);
  console.log(`  ✓ ${sz} KB`);
  SEGMENTS.push({ path: segOut, duration: segDur });
  totalDuration += segDur;
}

console.log(`\n${SEGMENTS.length} segments, ${totalDuration.toFixed(1)}s total`);

// Concat
fs.writeFileSync(CONCAT_LIST, SEGMENTS.map(s => `file '${s.path.replace(/'/g, "'\\''")}'`).join("\n"));

const finalOut = path.join(OUTPUT, "video_fast.mp4");
console.log("\nConcatenating...");

execFileSync("ffmpeg", [
  "-y", "-f", "concat", "-safe", "0", "-i", CONCAT_LIST,
  "-c", "copy",
  "-movflags", "+faststart",
  finalOut
], { timeout: 30000, stdio: "pipe" });

const finalSz = Math.round(fs.statSync(finalOut).size / 1024 / 1024 * 10) / 10;
const dur = execFileSync("ffprobe", ["-v","quiet","-show_entries","format=duration","-of","csv=p=0", finalOut], {encoding:"utf8",timeout:8000});
console.log(`\nDone! ${finalOut}`);
console.log(`Duration: ${parseFloat(dur.trim()).toFixed(1)}s | Size: ${finalSz} MB`);
