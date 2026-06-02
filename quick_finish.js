#!/usr/bin/env node
// quick_finish.js — Concat what we have, render scene 4 fast
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT = "/root/ianews";
const IMAGES = path.join(PROJECT, "public/images");
const AUDIO = path.join(PROJECT, "public/audio");
const OUTPUT = path.join(PROJECT, "output");
const CONCAT_LIST = path.join(PROJECT, "concat_list.txt");
const FPS = 30;

const script = JSON.parse(fs.readFileSync(path.join(PROJECT, "data/script.json"), "utf-8"));

// Render scene 4 with fast settings
const scene = script.scenes[3];
const num = 4;
let imgPath = path.join(IMAGES, `scene_${num}.jpg`);
if (!fs.existsSync(imgPath)) imgPath = path.join(IMAGES, `scene_${num}.png`);
const audioPath = path.join(AUDIO, `scene_${num}.mp3`);
const segOut = path.join(OUTPUT, `segment_hq_4.mp4`);

let audioDuration;
try {
  const d = execFileSync("ffprobe", ["-v","quiet","-show_entries","format=duration","-of","csv=p=0", audioPath], {encoding:"utf8",timeout:8000});
  audioDuration = parseFloat(d.trim());
} catch { audioDuration = scene.duration_seconds || 7; }

const segDur = Math.round((audioDuration + 0.2) * 100) / 100;
const frames = Math.round(segDur * FPS);

console.log(`Scene 4: ${audioDuration.toFixed(1)}s → ${segDur}s (${frames}f) — ultrafast zoompan`);

execFileSync("ffmpeg", [
  "-y", "-loop", "1", "-i", imgPath, "-i", audioPath,
  "-vf", `zoompan=z='min(zoom+0.001,1.1)':d=${frames}:s=1080x1920:fps=${FPS},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p`,
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
  "-c:a", "aac", "-b:a", "128k",
  "-t", String(segDur), "-shortest",
  "-movflags", "+faststart",
  segOut
], { timeout: 60000, stdio: "pipe" });

console.log(`  Scene 4: ${(fs.statSync(segOut).size/1024/1024).toFixed(2)} MB`);

// Concat all 4
const SEGMENTS = [1,2,3,3].map(n => ({ path: path.join(OUTPUT, `segment_hq_${n}.mp4`) }));
SEGMENTS[3] = { path: segOut }; // fix: scene 4 not scene 3 again
const segs = [1,2,3,4].map(n => ({ path: path.join(OUTPUT, `segment_hq_${n}.mp4`) }));

fs.writeFileSync(CONCAT_LIST, segs.map(s => `file '${s.path.replace(/'/g, "'\\''")}'`).join("\n"));

const finalOut = path.join(OUTPUT, "video_hq.mp4");
const compressedOut = path.join(PROJECT, "video_compressed_hq.mp4");

console.log("\nConcatenating...");
execFileSync("ffmpeg", [
  "-y", "-f", "concat", "-safe", "0", "-i", CONCAT_LIST,
  "-c", "copy", "-movflags", "+faststart", finalOut
], { timeout: 30000, stdio: "pipe" });

const finalSz = fs.statSync(finalOut).size;
const dur = execFileSync("ffprobe", ["-v","quiet","-show_entries","format=duration","-of","csv=p=0", finalOut], {encoding:"utf8",timeout:8000});
console.log(`\n✓ FULL HD: ${finalOut} — ${(finalSz/1024/1024).toFixed(1)} MB, ${parseFloat(dur.trim()).toFixed(1)}s`);

// Compress for Telegram
console.log("\nCompressing for Telegram...");
execFileSync("ffmpeg", [
  "-y", "-i", finalOut,
  "-c:v", "libx264", "-preset", "fast", "-crf", "22",
  "-c:a", "aac", "-b:a", "64k",
  "-vf", "scale=576:1024,format=yuv420p",
  "-movflags", "+faststart",
  compressedOut
], { timeout: 120000, stdio: "pipe" });

const compSz = fs.statSync(path.join(PROJECT, "video_compressed_hq.mp4")).size;
console.log(`\n✓ COMPRESSED: video_compressed_hq.mp4 — ${(compSz/1024/1024).toFixed(1)} MB`);
console.log("DONE!");
