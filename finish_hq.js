#!/usr/bin/env node
// finish_hq.js
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const OUTPUT = "/root/ianews/output";
const IMAGES = "/root/ianews/public/images";
const AUDIO = "/root/ianews/public/audio";
const FPS = 30;

async function main() {
  // Scene 4 - fast render
  const num = 4;
  let imgPath = path.join(IMAGES, `scene_${num}.jpg`);
  if (!fs.existsSync(imgPath)) imgPath = path.join(IMAGES, `scene_${num}.png`);
  const audioPath = path.join(AUDIO, `scene_${num}.mp3`);
  const segOut = path.join(OUTPUT, `segment_hq_${num}.mp4`);

  let audioDuration;
  try {
    const d = execFileSync("ffprobe", ["-v","quiet","-show_entries","format=duration","-of","csv=p=0", audioPath], {encoding:"utf8",timeout:8000});
    audioDuration = parseFloat(d.trim());
  } catch { audioDuration = 9; }

  const segDur = Math.round((audioDuration + 0.2) * 100) / 100;
  console.log(`Scene 4: ${audioDuration.toFixed(1)}s → ${segDur}s`);

  execFileSync("ffmpeg", [
    "-y", "-loop", "1", "-i", imgPath, "-i", audioPath,
    "-vf", `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=${segDur-0.5}:d=0.5`,
    "-c:v", "libx264", "-preset", "fast", "-crf", "20",
    "-c:a", "aac", "-b:a", "128k",
    "-r", String(FPS), "-t", String(segDur), "-shortest",
    "-movflags", "+faststart", segOut
  ], { timeout: 60000, stdio: "pipe" });
  console.log(`  ✓ ${(fs.statSync(segOut).size/1024/1024).toFixed(2)} MB`);

  // Concat all 4
  const CONCAT_LIST = path.join(OUTPUT, "concat_list_hq.txt");
  const segs = [1,2,3,4].map(n => path.join(OUTPUT, `segment_hq_${n}.mp4`));
  fs.writeFileSync(CONCAT_LIST, segs.map(s => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"));

  const finalOut = path.join(OUTPUT, "video_hq.mp4");
  console.log("\nConcatenating...");
  execFileSync("ffmpeg", ["-y","-f","concat","-safe","0","-i", CONCAT_LIST, "-c","copy","-movflags","+faststart", finalOut], {timeout:30000,stdio:"pipe"});

  const finalSz = fs.statSync(finalOut).size;
  const dur = execFileSync("ffprobe", ["-v","quiet","-show_entries","format=duration","-of","csv=p=0", finalOut], {encoding:"utf8",timeout:8000});
  console.log(`\n✓ HD: ${finalOut} — ${(finalSz/1024/1024).toFixed(1)} MB, ${parseFloat(dur.trim()).toFixed(1)}s`);

  // Compress
  const compOut = "/root/ianews/video_compressed_hq.mp4";
  console.log("\nCompressing...");
  execFileSync("ffmpeg", [
    "-y","-i", finalOut,
    "-c:v","libx264","-preset","fast","-crf","22",
    "-c:a","aac","-b:a","64k",
    "-vf","scale=576:1024,format=yuv420p",
    "-movflags","+faststart", compOut
  ], {timeout:120000,stdio:"pipe"});

  const compSz = fs.statSync(compOut).size;
  const compDur = execFileSync("ffprobe", ["-v","quiet","-show_entries","format=duration","-of","csv=p=0", compOut], {encoding:"utf8",timeout:8000});
  console.log(`\n✓ Compressed: ${(compSz/1024/1024).toFixed(1)} MB, ${parseFloat(compDur.trim()).toFixed(1)}s`);
  console.log("DONE!");
}

main().catch(e => { console.error(e.message); process.exit(1); });
