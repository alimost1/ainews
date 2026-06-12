#!/usr/bin/env node
// build_all_scenes.js — Build all segments with corrected mouth position and captions
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT = "/root/ianews";
const IMAGES = path.join(PROJECT, "public/images");
const AUDIO = path.join(PROJECT, "public/audio");
const OUTPUT = path.join(PROJECT, "output");
const DATA = path.join(PROJECT, "data");
const AVATAR_TALK = path.join(PROJECT, "public/avatar_talking.mp4");

const FPS = 30;
const W = 576, H = 1024;
const FONT = "/usr/share/fonts/opentype/fonts-hosny-amiri/Amiri-Bold.ttf";

function escText(t) {
  return t.replace(/\\/g, "\\\\").replace(/'/g, "'\\\\''");
}

if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

const script = JSON.parse(fs.readFileSync(path.join(DATA, "script.json"), "utf-8"));

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
    dur = parseFloat(execSync("ffprobe -v quiet -show_entries format=duration -of csv=p=0 " + aud, { encoding: "utf8", timeout: 10000 }).trim());
  } catch (e) { dur = 7; }

  const segDur = Math.round((dur + 0.3) * 100) / 100;
  const caption = (scene.caption_text || "").trim();

  console.log("Scene " + num + ": " + dur.toFixed(1) + "s | \"" + caption + "\"");

  const filters = [];
  filters.push("drawbox=x=0:y=ih*0.78:w=iw:h=ih*0.22:color=black@0.65:t=fill");

  if (caption) {
    const words = caption.split(/\s+/).filter(w => w.length > 0);
    const groups = [];
    const groupSize = Math.ceil(words.length / 2);
    for (let i = 0; i < words.length; i += groupSize) {
      groups.push(words.slice(i, i + groupSize).join(" "));
    }
    const groupDur = segDur / groups.length;

    filters.push(
      "drawtext=fontfile=" + FONT + ":text='" + escText(caption) + "'" +
      ":fontsize=56:fontcolor=white@0.35" +
      ":x=(w-text_w)/2:y=h-th-55" +
      ":text_shaping=1"
    );

    let t = 0;
    for (let i = 0; i < groups.length; i++) {
      const g = escText(groups[i]);
      const tEnd = t + groupDur;
      filters.push(
        "drawtext=fontfile=" + FONT + ":text='" + g + "'" +
        ":fontsize=60:fontcolor=yellow@1.0" +
        ":x=(w-text_w)/2:y=h-th-55" +
        ":text_shaping=1" +
        ":enable='between(t," + t.toFixed(2) + "," + (tEnd + 0.1).toFixed(2) + ")'"
      );
      t = tEnd;
    }
  }

  filters.push("format=yuv420p");

  let ffmpegCmd;
  if (fs.existsSync(AVATAR_TALK)) {
    ffmpegCmd =
      "ffmpeg -y -loop 1 -i " + JSON.stringify(img) +
      " -stream_loop -1 -i " + JSON.stringify(AVATAR_TALK) +
      " -i " + JSON.stringify(aud) +
      " -filter_complex \"[0:v]scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + "," + filters.join(",") + "[bg];[1:v]format=rgba[avt];[bg][avt]overlay=8:main_h*0.78-overlay_h-8:shortest=1[outv]\"" +
      " -map \"[outv]\" -map 2:a" +
      " -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 128k" +
      " -t " + segDur + " -r " + FPS + " -movflags +faststart" +
      " " + JSON.stringify(seg);
  } else {
    ffmpegCmd =
      "ffmpeg -y -loop 1 -i " + JSON.stringify(img) +
      " -i " + JSON.stringify(aud) +
      " -vf \"" + filters.join(",") + "\"" +
      " -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 128k" +
      " -t " + segDur + " -r " + FPS + " -movflags +faststart" +
      " " + JSON.stringify(seg);
  }

  try {
    execSync(ffmpegCmd, { timeout: 120000, stdio: "pipe", maxBuffer: 10 * 1024 * 1024 });
    console.log("  ✓ " + (fs.statSync(seg).size / 1024).toFixed(0) + " KB");
  } catch (err) {
    console.error("  ✗ " + (err.message || "").substring(0, 200));
  }
}

console.log("\nAll scenes built!");
