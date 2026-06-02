/**
 * render_ffmpeg.ts — Fast video rendering with ffmpeg
 * Compiles images + audio into a reel-format video without Remotion overhead
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { logger, CONFIG, readJSON } from "./src/agents/shared";

const OUTPUT_DIR = CONFIG.outputDir;
const IMAGES_DIR = CONFIG.imagesDir;
const AUDIO_DIR = CONFIG.audioDir;
const FRAMES_DIR = path.join(CONFIG.outputDir, "_frames");

function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

async function main() {
  logger.info("🎬 Starting fast ffmpeg render (reel format)...");

  // Load script with asset paths
  const script = readJSON<any>(path.join(CONFIG.dataDir, "script.json"));
  const scenes = script.scenes;

  ensureDir(OUTPUT_DIR);
  ensureDir(FRAMES_DIR);

  const width = CONFIG.videoWidth;   // 1080
  const height = CONFIG.videoHeight; // 1920
  const fps = CONFIG.fps;           // 30

  // ─── Step 1: Generate scene clips ───────────────────────────────
  const sceneMovies: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const imgPath = path.join(IMAGES_DIR, `scene_${scene.scene_number}.jpg`);
    const audioPath = path.join(AUDIO_DIR, `scene_${scene.scene_number}.mp3`);
    const outClip = path.join(FRAMES_DIR, `scene_${scene.scene_number}.mp4`);

    // Get actual audio duration
    let duration = scene.duration_seconds || 15;
    try {
      const probe = execSync(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`,
        { encoding: "utf-8" }
      ).trim();
      if (probe && !isNaN(parseFloat(probe))) {
        duration = Math.ceil(parseFloat(probe));
      }
    } catch { /* use default */ }

    // Check if image exists and is valid
    if (!fs.existsSync(imgPath) || fs.statSync(imgPath).size < 1000) {
      logger.warn(`Scene ${scene.scene_number}: no valid image, skipping`);
      continue;
    }

    // Create video clip: image + audio, scaled to 1080x1920 with Ken Burns zoom
    // Use ffmpeg for fast software rendering
    const zoomFilter = `zoompan=z='min(zoom+0.002,1.2)':d=${duration * fps}:s=${width}x${height}:fps=${fps}`;
    const scaleFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;

    const filterComplex = `[0]${scaleFilter}[img];[img]${zoomFilter}[v]`;

    try {
      execSync(
        `ffmpeg -y -loop 1 -i "${imgPath}" -i "${audioPath}" ` +
        `-filter_complex "${filterComplex}" ` +
        `-map "[v]" -map 1:a ` +
        `-c:v libx264 -preset fast -crf 23 -tune stillimage ` +
        `-c:a aac -b:a 192k -ar 48000 -ac 2 ` +
        `-r ${fps} -shortest -t ${duration} ` +
        `-pix_fmt yuv420p "${outClip}" 2>/dev/null`,
        { timeout: 60000, stdio: "pipe" }
      );
      sceneMovies.push(outClip);
      logger.success(`Scene ${scene.scene_number}: clip created (${duration}s)`);
    } catch (err: any) {
      logger.warn(`Scene ${scene.scene_number} failed: ${err.message?.substring(0, 80)}`);
    }

    // Small delay
    await new Promise(r => setTimeout(r, 500));
  }

  if (sceneMovies.length === 0) {
    logger.error("No scene clips generated!");
    process.exit(1);
  }

  // ─── Step 2: Concatenate all clips ──────────────────────────────
  const concatList = path.join(FRAMES_DIR, "concat.txt");
  const concatContent = sceneMovies.map(f => `file '${f}'`).join("\n");
  fs.writeFileSync(concatList, concatContent);

  const finalOutput = path.join(OUTPUT_DIR, "reel_output.mp4");

  logger.info(`Concatenating ${sceneMovies.length} scenes into final video...`);

  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatList}" ` +
    `-c:v libx264 -preset fast -crf 23 ` +
    `-c:a aac -b:a 192k -ar 48000 -ac 2 ` +
    `-movflags +faststart -pix_fmt yuv420p ` +
    `"${finalOutput}" 2>/dev/null`,
    { timeout: 120000, stdio: "pipe" }
  );

  // Clean up temp files
  try {
    fs.rmSync(FRAMES_DIR, { recursive: true });
    fs.unlinkSync(concatList);
  } catch {}

  // Verify output
  const stats = fs.statSync(finalOutput);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(1);

  logger.success(`✅ Video rendered: ${finalOutput} (${sizeMB} MB)`);

  // Get duration
  try {
    const durProbe = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${finalOutput}"`,
      { encoding: "utf-8" }
    ).trim();
    const totalSec = parseFloat(durProbe);
    logger.info(`Duration: ${Math.round(totalSec)}s | Format: ${width}x${height} @ ${fps}fps | Reel 9:16`);
  } catch {}

  return finalOutput;
}

main()
  .then((output) => {
    console.log(`\n🎬 Output: ${output}`);
    process.exit(0);
  })
  .catch((err) => {
    logger.error(`Render failed: ${err.message}`);
    process.exit(1);
  });
