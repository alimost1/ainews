#!/usr/bin/env node
// build_captioned_avatar.js — iAnews Video Builder with drawtext Captions + Avatar Overlay
// Optimized: pre-scale avatar, simpler filter chain

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT = "/root/ianews";
const IMAGES  = path.join(PROJECT, "public/images");
const AUDIO   = path.join(PROJECT, "public/audio");
const OUTPUT  = path.join(PROJECT, "output");
const CONCAT  = path.join(OUTPUT, "concat_list.txt");
const DATA    = path.join(PROJECT, "data");
const AVATAR  = path.join(PROJECT, "public/avatar.png");

const FPS = 30;
const W = 576, H = 1024;
const FONT = "/usr/share/fonts/opentype/fonts-hosny-amiri/Amiri-Bold.ttf";
const SEGMENTS = [];

if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

const script = JSON.parse(fs.readFileSync(path.join(DATA, "script.json"), "utf-8"));

console.log("\n" + "=".repeat(55));
console.log("🎬 iAnews Video Builder — Avatar + Captions");
console.log("=".repeat(55));
console.log("Topic:  " + (script.topic || script.title));
console.log("Scenes: " + script.scenes.length);
console.log("Avatar: " + (fs.existsSync(AVATAR) ? "✅ found" : "❌ missing") + "\n");

// Pre-scale avatar to target size for faster overlay
const AVATAR_W = 300;
const AVATAR_PRE = path.join(PROJECT, "public/avatar_resized.png");
if (fs.existsSync(AVATAR)) {
  try {
    execSync(
      "ffmpeg -y -i " + JSON.stringify(AVATAR) +
      " -vf \"scale=" + AVATAR_W + ":-1,format=rgba\"" +
      " " + JSON.stringify(AVATAR_PRE),
      { timeout: 30000, stdio: "pipe" }
    );
    console.log("✅ Avatar pre-scaled: " + (fs.statSync(AVATAR_PRE).size / 1024).toFixed(0) + " KB\n");
  } catch (e) {
    console.error("⚠️ Avatar pre-scale failed, using original\n");
  }
}

function escText(t) {
  return t.replace(/\\/g, "\\\\").replace(/'/g, "'\\\\''");
}

const AVATAR_X = 8;
const AVATAR_Y_OFF = 8;

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
  const caption = (scene.caption_text || "").trim();

  console.log("Scene " + num + ": " + dur.toFixed(1) + "s | \"" + caption + "\"");

  // Build drawtext filters
  const filters = [];

  // Dark caption background bar (bottom 22%)
  filters.push("drawbox=x=0:y=ih*0.78:w=iw:h=ih*0.22:color=black@0.55:t=fill");

  if (caption) {
    const words = caption.split(/\s+/).filter(w => w.length > 0);
    const groups = [];
    const groupSize = Math.ceil(words.length / 2);
    for (let i = 0; i < words.length; i += groupSize) {
      groups.push(words.slice(i, i + groupSize).join(" "));
    }
    const groupDur = segDur / groups.length;

    // Base layer: full caption dimmed
    filters.push(
      "drawtext=fontfile=" + FONT + ":text='" + escText(caption) + "'" +
      ":fontsize=48:fontcolor=white@0.30" +
      ":x=(w-text_w)/2:y=h-th-80" +
      ":shadowcolor=black@0.9:shadowx=2:shadowy=2:text_shaping=1"
    );

    // Highlight groups sequentially
    let t = 0;
    for (let i = 0; i < groups.length; i++) {
      const g = escText(groups[i]);
      const tEnd = t + groupDur;
      filters.push(
        "drawtext=fontfile=" + FONT + ":text='" + g + "'" +
        ":fontsize=48:fontcolor=#FFD700" +
        ":x=(w-text_w)/2:y=h-th-80" +
        ":shadowcolor=black@0.9:shadowx=2:shadowy=2:text_shaping=1" +
        ":enable='between(t," + t.toFixed(2) + "," + (tEnd + 0.1).toFixed(2) + ")'"
      );
      t = tEnd;
    }
  }

  try {
    let ffmpegCmd;
    const hasAvatar = fs.existsSync(AVATAR_PRE);

    if (hasAvatar) {
      // Use pre-scaled avatar with simple overlay
      // scale+crop image to 576x1024, apply drawtext, then overlay avatar
      // Position avatar above the caption bar: main_h*0.78 - overlay_h - margin
      const avatarYExpr = "main_h*0.78-overlay_h-" + AVATAR_Y_OFF;
      ffmpegCmd =
        "ffmpeg -y -loop 1 -i " + JSON.stringify(img) +
        " -i " + JSON.stringify(aud) +
        " -loop 1 -i " + JSON.stringify(AVATAR_PRE) +
        " -filter_complex \"[0:v]scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + "," + filters.join(",") + "[bg];[bg][2:v]overlay=" + AVATAR_X + ":" + avatarYExpr + ":shortest=1,format=yuv420p[outv]\"" +
        " -map \"[outv]\" -map 1:a" +
        " -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 128k" +
        " -t " + segDur + " -r " + FPS + " -movflags +faststart" +
        " " + JSON.stringify(seg);
    } else {
      ffmpegCmd =
        "ffmpeg -y -loop 1 -i " + JSON.stringify(img) +
        " -i " + JSON.stringify(aud) +
        " -vf \"scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + "," + filters.join(",") + ",format=yuv420p\"" +
        " -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 128k" +
        " -t " + segDur + " -r " + FPS + " -movflags +faststart" +
        " " + JSON.stringify(seg);
    }

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
console.log("   Avatar:    bottom-left overlay");
console.log("   Font:      Amiri Bold (text_shaping=1)");
console.log("=".repeat(55));

// Cleanup
try {
  fs.unlinkSync(CONCAT);
  SEGMENTS.forEach(function(s) { try { fs.unlinkSync(s.path); } catch(e) {} });
} catch(e) {}
