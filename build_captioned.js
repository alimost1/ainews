#!/usr/bin/env node
// build_captioned.js — iAnews Video Builder with drawtext Captions
//
// Pipeline:
//   1. Build segments from images+audio+drawtext at 576×1024 (ultrafast)
//   2. Concatenate with -c copy (fast, no re-encode)
//
// Caption style: Amiri Bold 72pt, white + gold highlight, black shadow, dark bg bar

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT = "/root/ianews";
const IMAGES  = path.join(PROJECT, "public/images");
const AUDIO   = path.join(PROJECT, "public/audio");
const OUTPUT  = path.join(PROJECT, "output");
const CONCAT  = path.join(OUTPUT, "concat_list.txt");
const DATA    = path.join(PROJECT, "data");

const FPS = 30;
const W = 576, H = 1024;
const FONT = "/usr/share/fonts/truetype/amiri/amiri-bold.ttf";
const SEGMENTS = [];

if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

const script = JSON.parse(fs.readFileSync(path.join(DATA, "script.json"), "utf-8"));

console.log("\n" + "=".repeat(55));
console.log("🎬 iAnews Video Builder — drawtext Captions");
console.log("=".repeat(55));
console.log("Topic:  " + script.topic);
console.log("Scenes: " + script.scenes.length + "\n");

function escText(t) {
  return t.replace(/\\/g, "\\\\").replace(/'/g, "'\\\\''");
}

// ─── Step 1: Build segments ───────────────────────────────────────

for (const scene of script.scenes) {
  const num = scene.scene_number;
  let img = path.join(IMAGES, "scene_" + num + ".png");
  if (!fs.existsSync(img)) img = path.join(IMAGES, "scene_" + num + ".jpg");
  const aud = path.join(AUDIO, "scene_" + num + ".mp3");
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

  // Scale filter: cover-fill from source to 576×1024
  const scaleFilter = "scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H;

  // Build filter chain — dark bg + dim white caption + gold highlight per phrase
  const filters = [scaleFilter];

  // Dark caption background bar (bottom 22%)
  filters.push("drawbox=x=0:y=ih*0.78:w=iw:h=ih*0.22:color=black@0.55:t=fill");

  if (caption) {
    // Split caption into 2-3 word groups for highlight
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

  filters.push("format=yuv420p");

  // Simpler approach: use -vf with comma-separated filters at 576×1024 (fast)
  // At this resolution, -vf works fine (shorter filter string)
  const filterStr = filters.join(",");

  try {
    execSync(
      "ffmpeg -y -loop 1 -i " + JSON.stringify(img) +
      " -i " + JSON.stringify(aud) +
      " -vf \"" + filterStr + "\"" +
      " -c:v libx264 -preset ultrafast -crf 24 -c:a aac -b:a 128k" +
      " -t " + segDur + " -shortest -r " + FPS + " -movflags +faststart" +
      " " + JSON.stringify(seg),
      { timeout: 120000, stdio: "pipe", maxBuffer: 10 * 1024 * 1024 }
    );
    const sz = fs.statSync(seg).size;
    console.log("  ✓ " + (sz / 1024).toFixed(0) + " KB");
    SEGMENTS.push({ path: seg, duration: segDur });
  } catch (err) {
    console.error("  ✗ " + (err.message || "").substring(0, 120));
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
console.log("   Font:      Amiri Bold (text_shaping=1)");
console.log("=".repeat(55));

// Cleanup
try {
  fs.unlinkSync(CONCAT);
  SEGMENTS.forEach(function(s) { try { fs.unlinkSync(s.path); } catch(e) {} });
} catch(e) {}
