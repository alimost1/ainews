#!/usr/bin/env node
// hq_build.js — High quality video build
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

console.log(`HQ Build: ${script.topic}\n`);

for (const scene of script.scenes) {
  const num = scene.scene_number;
  let imgPath = path.join(IMAGES, `scene_${num}.jpg`);
  if (!fs.existsSync(imgPath)) imgPath = path.join(IMAGES, `scene_${num}.png`);
  const audioPath = path.join(AUDIO, `scene_${num}.mp3`);
  const segOut = path.join(OUTPUT, `segment_hq_${num}.mp4`);

  let audioDuration;
  try {
    const d = execFileSync("ffprobe", ["-v","quiet","-show_entries","format=duration","-of","csv=p=0", audioPath], {encoding:"utf8",timeout:8000});
    audioDuration = parseFloat(d.trim());
  } catch { audioDuration = scene.duration_seconds || 7; }

  const segDur = Math.round((audioDuration + 0.2) * 100) / 100;
  const frames = Math.round(segDur * FPS);

  console.log(`Scene ${num}: ${audioDuration.toFixed(1)}s → ${segDur}s @ ${frames}f`);
  console.log(`  Image: ${Math.round(fs.statSync(imgPath).size/1024)} KB | Audio: ${Math.round(fs.statSync(audioPath).size/1024)} KB`);

  try {
    execFileSync("ffmpeg", [
      "-y",
      "-loop", "1", "-i", imgPath,
      "-i", audioPath,
      "-vf", `zoompan=z='min(zoom+0.0006,1.08)':d=${frames}:s=1080x1920:fps=${FPS}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "128k",
      "-t", String(segDur),
      "-shortest",
      "-movflags", "+faststart",
      segOut
    ], { timeout: 120000, stdio: "pipe" });

    const sz = fs.statSync(segOut).size;
    console.log(`  ✓ ${(sz / 1024 / 1024).toFixed(2)} MB`);
    SEGMENTS.push({ path: segOut, duration: segDur });
    totalDuration += segDur;
  } catch (err) {
    console.error(`  ✗ ${err.message?.substring(0, 100)}`);
  }
}

console.log(`\n${SEGMENTS.length} segments, ${totalDuration.toFixed(1)}s total`);

if (SEGMENTS.length === 0) { console.error("No segments!"); process.exit(1); }

// Concat
fs.writeFileSync(CONCAT_LIST, SEGMENTS.map(s => `file '${s.path.replace(/'/g, "'\\''")}'`).join("\n"));

const finalOut = path.join(OUTPUT, "video_hq.mp4");
const compressedOut = path.join(OUTPUT, "video_compressed.mp4");

console.log("\nConcatenating...");
execFileSync("ffmpeg", [
  "-y", "-f", "concat", "-safe", "0", "-i", CONCAT_LIST,
  "-c", "copy", "-movflags", "+faststart", finalOut
], { timeout: 30000, stdio: "pipe" });

const finalSz = fs.statSync(finalOut).size;
const dur = execFileSync("ffprobe", ["-v","quiet","-show_entries","format=duration","-of","csv=p=0", finalOut], {encoding:"utf8",timeout:8000});
console.log(`\n✓ FULL HD: ${finalOut}`);
console.log(`  Duration: ${parseFloat(dur.trim()).toFixed(1)}s | Size: ${(finalSz/1024/1024).toFixed(1)} MB`);

// Compress for Telegram (576x1024, good quality)
console.log("\nCompressing for Telegram...");
execFileSync("ffmpeg", [
  "-y", "-i", finalOut,
  "-c:v", "libx264", "-preset", "medium", "-crf", "22",
  "-c:a", "aac", "-b:a", "64k",
  "-vf", "scale=576:1024,format=yuv420p",
  "-movflags", "+faststart",
  compressedOut
], { timeout: 120000, stdio: "pipe" });

const compSz = fs.statSync(compressedOut).size;
const compDur = execFileSync("ffprobe", ["-v","quiet","-show_entries","format=duration","-of","csv=p=0", compressedOut], {encoding:"utf8",timeout:8000});
console.log(`\n✓ COMPRESSED: ${compressedOut}`);
console.log(`  Duration: ${parseFloat(compDur.trim()).toFixed(1)}s | Size: ${(compSz/1024/1024).toFixed(1)} MB`);
console.log("\nDONE!");
