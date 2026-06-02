#!/usr/env node
// build_video.js — Direct ffmpeg-based video builder (no shell hooks)
const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT = "/root/ianews";
const IMAGES = path.join(PROJECT, "public/images");
const AUDIO = path.join(PROJECT, "public/audio");
const OUTPUT = path.join(PROJECT, "output");
const CONCAT_LIST = path.join(PROJECT, "concat_list.txt");

if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

const script = JSON.parse(fs.readFileSync(path.join(PROJECT, "data/script.json"), "utf-8"));
const FPS = 30;
const SEGMENTS = [];

console.log(`Building: ${script.topic}`);
console.log(`Scenes: ${script.scenes.length}`);

let totalDuration = 0;

for (const scene of script.scenes) {
  const num = scene.scene_number;
  // Try .jpg first, then .png
  let imgPath = path.join(IMAGES, `scene_${num}.jpg`);
  if (!fs.existsSync(imgPath)) {
    imgPath = path.join(IMAGES, `scene_${num}.png`);
  }
  const audioPath = path.join(AUDIO, `scene_${num}.mp3`);
  const segmentOut = path.join(OUTPUT, `segment_${num}.mp4`);

  if (!fs.existsSync(imgPath)) {
    console.error(`  ✗ Scene ${num}: image not found (${imgPath})`);
    continue;
  }
  if (!fs.existsSync(audioPath)) {
    console.error(`  ✗ Scene ${num}: audio not found (${audioPath})`);
    continue;
  }

  let audioDuration;
  try {
    const probe = execFileSync(
      "ffprobe",
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", audioPath],
      { encoding: "utf8", timeout: 10000 }
    );
    audioDuration = parseFloat(probe.trim());
  } catch {
    audioDuration = scene.duration_seconds || 7;
  }

  const segDuration = Math.round((audioDuration + 0.3) * 100) / 100;
  const totalFrames = Math.round(segDuration * FPS);

  console.log(`\nScene ${num}: ${audioDuration.toFixed(1)}s → ${segDuration.toFixed(2)}s (${totalFrames}f)`);
  console.log(`  Image: ${imgPath} (${Math.round(fs.statSync(imgPath).size/1024)} KB)`);
  console.log(`  Audio: ${audioPath} (${Math.round(fs.statSync(audioPath).size/1024)} KB)`);

  try {
    execFileSync("ffmpeg", [
      "-y",
      "-loop", "1", "-i", imgPath,
      "-i", audioPath,
      "-vf", `zoompan=z='min(zoom+0.0008,1.1)':d=${totalFrames}:s=1080x1920:fps=${FPS}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p`,
      "-c:v", "libx264", "-preset", "fast", "-crf", "22",
      "-c:a", "aac", "-b:a", "128k",
      "-t", String(segDuration), "-shortest",
      "-movflags", "+faststart",
      segmentOut
    ], { timeout: 120000, stdio: "pipe" });

    const stats = fs.statSync(segmentOut);
    console.log(`  ✓ ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
    SEGMENTS.push({ path: segmentOut, duration: segDuration });
    totalDuration += segDuration;
  } catch (err) {
    console.error(`  ✗ ${err.message?.substring(0, 100)}`);
  }
}

console.log(`\n--- ${SEGMENTS.length} segments, ${totalDuration.toFixed(1)}s ---`);

if (SEGMENTS.length === 0) {
  console.error("No segments produced!");
  process.exit(1);
}

// Concat
const concatContent = SEGMENTS.map(s => `file '${s.path.replace(/'/g, "'\\''")}'`).join("\n");
fs.writeFileSync(CONCAT_LIST, concatContent);

const finalOutput = path.join(OUTPUT, "video.mp4");
const compressedOutput = path.join(OUTPUT, "video_compressed.mp4");

console.log("\nConcatenating...");
try {
  execFileSync("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", CONCAT_LIST,
    "-c:v", "libx264", "-preset", "fast", "-crf", "22",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    finalOutput
  ], { timeout: 120000, stdio: "pipe" });

  const finalStats = fs.statSync(finalOutput);
  const dur = execFileSync("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", finalOutput], { encoding: "utf8", timeout: 10000 });
  console.log(`\n✓ VIDEO: ${finalOutput}`);
  console.log(`  Duration: ${parseFloat(dur.trim()).toFixed(1)}s | Size: ${(finalStats.size/1024/1024).toFixed(1)} MB`);

  // Compress for Telegram
  console.log("\nCompressing for Telegram (576x1024)...");
  execFileSync("ffmpeg", [
    "-y", "-i", finalOutput,
    "-c:v", "libx264", "-preset", "fast", "-crf", "28",
    "-c:a", "aac", "-b:a", "64k",
    "-vf", "scale=576:1024,format=yuv420p",
    "-movflags", "+faststart",
    compressedOutput
  ], { timeout: 120000, stdio: "pipe" });

  const compStats = fs.statSync(compressedOutput);
  const compDur = execFileSync("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", compressedOutput], { encoding: "utf8", timeout: 10000 });
  console.log(`\n✓ COMPRESSED: ${compressedOutput}`);
  console.log(`  Duration: ${parseFloat(compDur.trim()).toFixed(1)}s | Size: ${(compStats.size/1024/1024).toFixed(1)} MB`);
  console.log("\nDONE — ready to send!");
} catch (err) {
  console.error(`Failed: ${err.message?.substring(0, 200)}`);
  process.exit(1);
}
