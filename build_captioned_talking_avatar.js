#!/usr/bin/env node
// build_captioned_talking_avatar.js — iAnews Video Builder (NO Avatar)
//
// Pipeline:
//   1. Build segments from images+audio+drawtext at 576x1024
//   2. Concatenate with -c copy
//
// NOTE: Avatar overlay removed — captions only, no talking head.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT = "/root/ianews";
const IMAGES      = path.join(PROJECT, "public/images");
const AUDIO       = path.join(PROJECT, "public/audio");
const OUTPUT      = path.join(PROJECT, "output");
const CONCAT      = path.join(OUTPUT, "concat_list.txt");
const DATA        = path.join(PROJECT, "data");

const FPS = 30;
const W = 576, H = 1024;
const FONT = "/usr/share/fonts/opentype/fonts-hosny-amiri/Amiri-Bold.ttf";
const SEGMENTS = [];

if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

const script = JSON.parse(fs.readFileSync(path.join(DATA, "script.json"), "utf-8"));

console.log("\n" + "=".repeat(55));
console.log("🎬 iAnews Video Builder — Captions Only (No Avatar)");
console.log("=".repeat(55));
console.log("Topic:  " + (script.topic || script.title));
console.log("Scenes: " + script.scenes.length + "\n");

function escText(t) {
  // Escape for ffmpeg drawtext when using filter_complex_script
  // ffmpeg drawtext: colons in text must be escaped as \:
  return t
    .replace(/\u201C/g, '"').replace(/\u201D/g, '"')
    .replace(/\u2018/g, "'").replace(/\u2019/g, "'")
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:');
}

// ─── Step 1: Build segments ───────────────────────────────────────

for (const scene of script.scenes) {
  const num = scene.scene_number;
  let img = path.join(IMAGES, "scene_" + num + ".png");
  if (!fs.existsSync(img)) img = path.join(IMAGES, "scene_" + num + ".jpg");
  let aud = path.join(AUDIO, "scene_" + num + ".wav");
  if (!fs.existsSync(aud)) aud = path.join(AUDIO, "scene_" + num + ".mp3");
  const seg = path.join(OUTPUT, "segment_" + num + ".mp4");

  if (!fs.existsSync(img)) { console.error("  ✗ Scene " + num + ": no image"); continue; }
  if (!fs.existsSync(aud)) { console.error("  ✗ Scene " + num + ": no audio"); continue; }

  let dur;
  try {
    dur = parseFloat(execSync(
      "ffprobe -v quiet -show_entries format=duration -of csv=p=0 " + aud,
      { encoding: "utf8", timeout: 10000 }).trim());
  } catch (e) { dur = 7; }

  const segDur = Math.round((dur + 0.3) * 100) / 100;
  // Use narration_text (full TTS content) for captions instead of short caption_text
  const caption = (scene.narration_text || scene.caption_text || "").trim();

  console.log("Scene " + num + ": " + dur.toFixed(1) + "s | words: " + caption.split(/\s+/).length);

  // Build drawtext filters (no background bar)
  const filters = [];

  if (caption) {
    const words = caption.split(/\s+/).filter(w => w.length > 0);
    const wordDur = segDur / words.length;

    // Base layer: full narration dimmed (white, semi-transparent)
    // Position: bottom of screen with margin above for YouTube UI
    filters.push(
      "drawtext=fontfile=" + FONT + ":text='" + escText(caption) + "'" +
      ":fontsize=44:fontcolor=white@0.35" +
      ":x=(w-text_w)/2:y=h-th-80" +
      ":text_shaping=1:line_spacing=12:shadowcolor=black@0.6:shadowx=2:shadowy=2"
    );

    // Highlight each word sequentially (gold, fully opaque, larger)
    let t = 0;
    for (let i = 0; i < words.length; i++) {
      const w = escText(words[i]);
      const tEnd = t + wordDur;
      filters.push(
        "drawtext=fontfile=" + FONT + ":text='" + w + "'" +
        ":fontsize=52:fontcolor=yellow@1.0" +
        ":x=(w-text_w)/2:y=h-th-80" +
        ":text_shaping=1:shadowcolor=black@0.8:shadowx=2:shadowy=2" +
        ":enable='between(t," + t.toFixed(3) + "," + (tEnd + 0.05).toFixed(3) + ")'"
      );
      t = tEnd;
    }
  }

  filters.push("format=yuv420p");

  try {
    // Write filter_complex to temp file to avoid shell escaping issues with Arabic text
    const filterFile = "/tmp/afilter_" + num + ".txt";
    const filterStr = "[0:v]scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + "," + filters.join(",") + "[outv]";
    fs.writeFileSync(filterFile, filterStr);
    ffmpegCmd =
      "ffmpeg -y -loop 1 -i " + JSON.stringify(img) +
      " -i " + JSON.stringify(aud) +
      " -filter_complex_script " + JSON.stringify(filterFile) +
      " -map \"[outv]\" -map 1:a" +
      " -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 128k" +
      " -t " + segDur + " -r " + FPS + " -movflags +faststart" +
      " " + JSON.stringify(seg);

    execSync(ffmpegCmd, { timeout: 90000, stdio: "pipe", maxBuffer: 10 * 1024 * 1024 });
    const sz = fs.statSync(seg).size;
    console.log("  ✓ " + (sz / 1024).toFixed(0) + " KB");
    SEGMENTS.push({ path: seg, duration: segDur });
  } catch (err) {
    console.error("  ✗ " + (err.message || "").substring(0, 200));
  }
}

if (SEGMENTS.length === 0) { console.error("\n✗ No segments!"); process.exit(1); }

// ─── Step 2: Concatenate ───────────────────────────────────────────

console.log("\nConcatenating " + SEGMENTS.length + " segments...");
process.chdir(OUTPUT);
const concatContent = SEGMENTS.map(function(s) {
  return "file '" + path.basename(s.path) + "'";
}).join("\n");
fs.writeFileSync(CONCAT, concatContent);

const finalVideo = path.join(OUTPUT, "video_final.mp4");
execSync(
  "ffmpeg -y -f concat -safe 0 -i " + JSON.stringify(CONCAT) +
  " -c copy -movflags +faststart " + JSON.stringify(finalVideo),
  { timeout: 60000, stdio: "pipe", maxBuffer: 10 * 1024 * 1024 }
);

const finDur = parseFloat(execSync(
  "ffprobe -v quiet -show_entries format=duration -of csv=p=0 " + JSON.stringify(finalVideo),
  { encoding: "utf8", timeout: 10000 }).trim());
const finSz = fs.statSync(finalVideo).size;

console.log("\n" + "=".repeat(55));
console.log("✅ DONE — " + finalVideo);
console.log("   Duration:  " + finDur.toFixed(1) + "s");
console.log("   Size:      " + (finSz / 1024).toFixed(0) + " KB");
console.log("   Codec:     H.264 + AAC @ " + W + "x" + H);
console.log("   Caption:   drawtext highlight (gold phrase-by-phrase)");
console.log("   Avatar:    ❌ removed (captions only)");
console.log("   Font:      Amiri Bold (text_shaping=1)");
console.log("=".repeat(55));

// ─── Step 3: Auto-post to Facebook + YouTube ─────────────────────────
const TOKEN_FILE = path.join(DATA, "fb_tokens.json");
const YT_TOKEN_FILE = "/root/.config/google/youtube_token.json";
const descPath = path.join(OUTPUT, "fb_description.txt");

// Generate description
const description = script.title + "\n\n" + (script.hashtags || "#iAnews #أخبار");
fs.writeFileSync(descPath, description);

// Facebook auto-post
if (fs.existsSync(TOKEN_FILE)) {
  try {
    const fbTokens = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
    if (fbTokens.pageToken && fbTokens.pageId) {
      console.log("\n📤 Auto-posting to Facebook...");
      const http = require("http");
      const postData = JSON.stringify({ videoPath: finalVideo, description: description });
      const postReq = http.request({
        hostname: "127.0.0.1", port: 8090, path: "/api/post-video", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
      }, (postRes) => {
        let chunks = "";
        postRes.on("data", (d) => (chunks += d));
        postRes.on("end", () => {
          try {
            const result = JSON.parse(chunks);
            if (result.success) {
              console.log("✅ Posted to Facebook!");
            } else {
              console.log("⚠️ FB post failed:", result.error || "Unknown");
            }
          } catch (e) { console.log("⚠️ FB post response:", chunks.substring(0, 200)); }
        });
      });
      postReq.on("error", (e) => console.log("⚠️ FB post error:", e.message));
      postReq.write(postData);
      postReq.end();
    } else {
      console.log("\n⚠️ FB tokens incomplete — skipping Facebook auto-post");
    }
  } catch (e) { console.log("\n⚠️ FB token read error:", e.message); }
} else {
  console.log("\n⚠️ No FB tokens found — skipping Facebook auto-post");
}

// YouTube auto-post
if (fs.existsSync(YT_TOKEN_FILE)) {
  try {
    console.log("\n📺 Auto-posting to YouTube...");
    const { execSync } = require("child_process");
    const ytTitle = script.title.substring(0, 100);
    const ytDesc = description.substring(0, 5000);
    const cmd = `python3 /root/ianews/scripts/youtube_upload.py "${finalVideo}" "${ytTitle}" "${descPath}" 2>&1`;
    const result = execSync(cmd, { timeout: 120000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    console.log(result);
  } catch (e) { console.log("⚠️ YouTube upload error:", e.message); }
} else {
  console.log("\n⚠️ No YouTube token found — skipping YouTube auto-post");
  console.log("   Connect at: https://ianews.executioneveryday.com");
}

// Cleanup
try {
  fs.unlinkSync(CONCAT);
  SEGMENTS.forEach(function(s) { try { fs.unlinkSync(s.path); } catch(e) {} });
} catch(e) {}
