#!/usr/bin/env node
// build_captioned_timed.js — iAnews Video Builder with Timed Narration Captions
//
// Uses edge-tts WordBoundary events to get word-level timings,
// groups words into phrases, and burns captions synchronized with TTS audio.

import { execSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = "/root/ianews";
const IMAGES = path.join(PROJECT, "public/images");
const AUDIO = path.join(PROJECT, "public/audio");
const OUTPUT = path.join(PROJECT, "output");
const DATA = path.join(PROJECT, "data");
const CONCAT = path.join(OUTPUT, "concat_list.txt");

const FPS = 30;
const W = 576, H = 1024;
const FONT = "/usr/share/fonts/opentype/fonts-hosny-amiri/Amiri-Bold.ttf";
const PYTHON = "/root/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu/bin/python3";
const SEGMENTS = [];

if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

const script = JSON.parse(fs.readFileSync(path.join(DATA, "script.json"), "utf-8"));

// ─── Clean old build artifacts ──────────────────────────────────
for (const f of fs.readdirSync(OUTPUT)) {
  if (/^(segment_|video_|concat_)/.test(f)) {
    fs.unlinkSync(path.join(OUTPUT, f));
  }
}

console.log("=".repeat(60));
console.log("🎬 iAnews Video Builder — Timed Narration Captions");
console.log("=".repeat(60));
console.log("Topic:  " + script.topic);
console.log("Scenes: " + script.scenes.length);

// ─── Get word timings via edge-tts WordBoundary ─────────────────

const TIMINGS_PY = `import asyncio, json, sys

async def main():
    import edge_tts
    text = sys.argv[1]
    voice = sys.argv[2]
    rate = sys.argv[3] if len(sys.argv) > 3 else "+0%"
    communicator = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    words = []
    async for chunk in communicator.stream():
        if chunk["type"] == "WordBoundary":
            words.append({
                "word": chunk["text"],
                "start": chunk["offset"] / 10000000,
                "duration": chunk.get("duration", 2000000) / 10000000
            })
    for i, w in enumerate(words):
        w["end"] = words[i+1]["start"] if i+1 < len(words) else w["start"] + w["duration"]
    print(json.dumps(words, ensure_ascii=False))

asyncio.run(main())
`;

const timingsPyPath = "/tmp/_get_timings.py";
fs.writeFileSync(timingsPyPath, TIMINGS_PY);

async function getWordTimings(text, voiceName, rate) {
  try {
    const raw = execFileSync(PYTHON, [timingsPyPath, text, voiceName, rate || "+0%"], {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch (err) {
    console.error("  WordBoundary failed:", err.message?.substring(0, 100));
    return null;
  }
}

// ─── Group words into phrases ────────────────────────────────────
function groupWordsIntoPhrases(words, targetPhraseLength = 4) {
  if (!words || words.length === 0) return [];

  const phrases = [];
  let current = [];

  for (const w of words) {
    current.push(w);
    if (current.length >= targetPhraseLength) {
      phrases.push({
        text: current.map(w => w.word).join(" ").trim(),
        start: current[0].start,
        end: current[current.length - 1].end,
      });
      current = [];
    }
  }

  if (current.length > 0) {
    phrases.push({
      text: current.map(w => w.word).join(" ").trim(),
      start: current[0].start,
      end: current[current.length - 1].end,
    });
  }

  return phrases;
}

// ─── Escape text for ffmpeg drawtext ─────────────────────────────
// The text goes inside single quotes in the shell command.
// In shell single quotes: 'text'\''more' handles embedded single quotes.
// We also escape backslashes and colons for ffmpeg drawtext.
function escText(t) {
  return t
    .replace(/\\/g, "\\\\")   // backslash → \\
    .replace(/:/g, "\\:")     // colon → \: (ffmpeg drawtext escape)
    .replace(/'/g, "'\\''");  // single quote → end quote, escaped quote, start quote
}

// ─── Main pipeline ───────────────────────────────────────────────

async function main() {
  for (const scene of script.scenes) {
    const num = scene.scene_number;
    let imgPath = path.join(IMAGES, "scene_" + num + ".png");
    if (!fs.existsSync(imgPath)) imgPath = path.join(IMAGES, "scene_" + num + ".jpg");
    const audPath = path.join(AUDIO, "scene_" + num + ".mp3");
    const segPath = path.join(OUTPUT, "segment_" + num + ".mp4");

    if (!fs.existsSync(imgPath)) { console.error("  ✗ Scene " + num + ": no image"); continue; }
    if (!fs.existsSync(audPath)) { console.error("  ✗ Scene " + num + ": no audio"); continue; }

    // Get actual audio duration
    let audDur;
    try {
      audDur = parseFloat(execSync(
        'ffprobe -v quiet -show_entries format=duration -of csv=p=0 "' + audPath + '"',
        { encoding: "utf8", timeout: 10000 }
      ).trim());
    } catch { audDur = scene.duration_seconds || 7; }

    const segDur = Math.round((audDur + 0.3) * 100) / 100;

    // Get voice name from mood
    const voiceMap = {
      "excited": "ar-AE-FatimaNeural",
      "hopeful": "ar-AE-FatimaNeural",
      "neutral": "ar-SA-ZariyahNeural",
      "serious": "ar-SA-HamedNeural",
      "calm": "ar-SA-ZariyahNeural",
      "urgent": "ar-SA-HamedNeural",
    };
    const voiceName = voiceMap[scene.mood] || "ar-SA-ZariyahNeural";

    console.log("\\nScene " + num + " (" + audDur.toFixed(1) + "s, voice: " + voiceName + ")");

    // Get word-level timings (rate="+10%" to match VoiceDirector settings)
    let words = await getWordTimings(scene.narration_text, voiceName, "+10%");
    let phrases = [];

    if (words && words.length > 0) {
      phrases = groupWordsIntoPhrases(words, 4);
      console.log("  ✓ " + words.length + " words → " + phrases.length + " phrases");
      for (const p of phrases) {
        console.log("    [" + p.start.toFixed(1) + "-" + p.end.toFixed(1) + "s] " + p.text);
      }
    } else {
      // Fallback: divide narration into time-based chunks
      console.warn("  ⚠ WordBoundary unavailable, using time-based fallback");
      const words_from_text = scene.narration_text.split(/\s+/).filter(w => w.length > 0);
      const chunkSize = 4;
      for (let i = 0; i < words_from_text.length; i += chunkSize) {
        const chunk = words_from_text.slice(i, i + chunkSize);
        phrases.push({
          text: chunk.join(" "),
          start: (i / words_from_text.length) * audDur,
          end: Math.min(((i + chunkSize) / words_from_text.length) * audDur, audDur),
        });
      }
      console.log("  " + phrases.length + " phrases (time-based fallback)");
    }

    // Scale filter
    const scaleFilter = "scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H;

    // Dark caption background bar
    const bgFilter = "drawbox=x=0:y=ih*0.78:w=iw:h=ih*0.22:color=black@0.60:t=fill";

    // Build phrase filters
    const phraseFilters = [];
    for (let i = 0; i < phrases.length; i++) {
      const p = phrases[i];
      const tStart = Math.max(0, p.start);
      const tEnd = Math.min(segDur, p.end + 0.15);
      const escaped = escText(p.text);

      phraseFilters.push(
        "drawtext=fontfile=" + FONT + ":text='" + escaped + "'" +
        ":fontsize=42:fontcolor=#FFD700" +
        ":x=(w-text_w)/2:y=h-th-90" +
        ":shadowcolor=black@0.9:shadowx=2:shadowy=2:text_shaping=1" +
        ":enable='between(t," + tStart.toFixed(3) + "," + tEnd.toFixed(3) + ")'"
      );
    }

    const filterStr = [scaleFilter, bgFilter, ...phraseFilters, "format=yuv420p"].join(",");

    console.log("  Building segment with " + phrases.length + " timed captions...");

    try {
      execSync(
        "ffmpeg -y -loop 1 -i " + JSON.stringify(imgPath) +
        " -i " + JSON.stringify(audPath) +
        ' -vf "' + filterStr + '"' +
        " -c:v libx264 -preset ultrafast -crf 24" +
        " -c:a aac -b:a 128k" +
        " -t " + segDur + " -shortest -r " + FPS + " -movflags +faststart" +
        " " + JSON.stringify(segPath),
        { timeout: 180000, stdio: "pipe", maxBuffer: 10 * 1024 * 1024 }
      );
      const sz = fs.statSync(segPath).size;
      console.log("  ✓ " + (sz / 1024).toFixed(0) + " KB");
      SEGMENTS.push({ path: segPath, duration: segDur });
    } catch (err) {
      console.error("  ✗ Build failed:", (err.message || "").substring(0, 150));
    }
  }

  if (SEGMENTS.length === 0) {
    console.error("\\n✗ No segments built!");
    process.exit(1);
  }

  // ─── Concatenate ────────────────────────────────────────────────
  console.log("\\n" + "=".repeat(60));
  console.log("Concatenating " + SEGMENTS.length + " segments...");
  process.chdir(OUTPUT);
  const concatContent = SEGMENTS.map(function(s) { return "file '" + path.basename(s.path) + "'"; }).join("\n");
  fs.writeFileSync(CONCAT, concatContent);

  const finalVideo = path.join(OUTPUT, "video_final.mp4");
  execSync(
    "ffmpeg -y -f concat -safe 0 -i " + JSON.stringify(CONCAT) +
    " -c copy -movflags +faststart " + JSON.stringify(finalVideo),
    { timeout: 60000, stdio: "pipe", maxBuffer: 10 * 1024 * 1024 }
  );

  const finDur = parseFloat(execSync(
    "ffprobe -v quiet -show_entries format=duration -of csv=p=0 " + JSON.stringify(finalVideo),
    { encoding: "utf8", timeout: 10000 }
  ).trim());
  const finSz = fs.statSync(finalVideo).size;

  console.log("\n" + "=".repeat(60));
  console.log("✅ DONE — " + finalVideo);
  console.log("   Duration:  " + finDur.toFixed(1) + "s");
  console.log("   Size:      " + (finSz / 1024).toFixed(0) + " KB (" + (finSz / 1024 / 1024).toFixed(1) + " MB)");
  console.log("   Codec:     H.264 + AAC @ " + W + "x" + H);
  console.log("   Captions:  Timed narration phrases (synchronized with TTS)");
  console.log("   Font:      Amiri Bold (text_shaping=1)");
  console.log("=".repeat(60));

  // Cleanup segments
  try {
    fs.unlinkSync(CONCAT);
    SEGMENTS.forEach(function(s) { try { fs.unlinkSync(s.path); } catch(e) {} });
  } catch(e) {}
}

main().catch(function(err) {
  console.error("Fatal:", err.message);
  process.exit(1);
});
