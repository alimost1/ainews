/**
 * VoiceDirector.ts — VoiceDirector Agent
 * Uses edge-tts to generate MP3 audio for each scene.
 */

import * as fs from "fs";
import { execFileSync } from "child_process";
import * as path from "path";
import { logger, CONFIG, readJSON, writeJSON, sleep } from "./shared";
import { MOOD_VOICE_MAP, MOOD_VOICE_MAP_AR } from "../types";
import type { Script, Scene, Mood } from "../types";

const SCRIPT_PATH = path.join(CONFIG.dataDir, "script.json");

export async function generateSceneAudio(scene: Scene, outputPath: string): Promise<number> {
  const voiceMap = CONFIG.language === "ar" ? MOOD_VOICE_MAP_AR : MOOD_VOICE_MAP;
  const voiceName = voiceMap[scene.mood];
  const rawMp3Path = outputPath.replace(/\.mp3$/, "_raw.mp3");
  const tmpTxtPath = path.join(path.dirname(outputPath), `_tmp_scene_${scene.scene_number}.txt`);
  logger.agent("VoiceDirector", `Scene ${scene.scene_number} (voice: ${voiceName})...`);
  try {
    fs.writeFileSync(tmpTxtPath, scene.narration_text, "utf-8");
    execFileSync("edge-tts", ["--voice", voiceName, "--rate=+10%", "--volume=+20%",
      "-f", tmpTxtPath, "--write-media", rawMp3Path], { timeout: 60000, stdio: "pipe" });
    execFileSync("ffmpeg", ["-y", "-i", rawMp3Path, "-af",
      "loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=80,lowpass=f=12000",
      "-ar", "48000", "-ac", "2", "-b:a", "192k", outputPath], { timeout: 30000, stdio: "pipe" });
    const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries",
      "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outputPath],
      { timeout: 10000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid audio duration");
    logger.success(`Scene ${scene.scene_number} audio saved (${duration.toFixed(2)}s)`);
    return duration;
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    throw new Error(`Narration failed for scene ${scene.scene_number}. Check edge-tts, ffmpeg and ffprobe.`, { cause: error });
  } finally {
    fs.rmSync(tmpTxtPath, { force: true });
    fs.rmSync(rawMp3Path, { force: true });
  }
}

export async function runVoiceDirector(): Promise<Script> {
  logger.agent("VoiceDirector", "🎙️ Starting VoiceDirector Agent...");

  let script: Script;
  try {
    script = readJSON<Script>(SCRIPT_PATH);
  } catch {
    throw new Error(`${SCRIPT_PATH} not found. Run ScriptWriter first.`);
  }

  const updatedScenes = [];
  for (const scene of script.scenes) {
    const audioPath = path.join(CONFIG.audioDir, `scene_${scene.scene_number}.mp3`);
    const duration = await generateSceneAudio(scene, audioPath);
    updatedScenes.push({ ...scene, audio_path: audioPath, audio_duration: duration });
    await sleep(300);
  }

  script = { ...script, scenes: updatedScenes };
  writeJSON(SCRIPT_PATH, script);
  logger.success(`All audio generated in ${CONFIG.audioDir}`);
  return script;
}

if (require.main === module) {
  runVoiceDirector()
    .then(() => process.exit(0))
    .catch((err) => { logger.error(err.message); process.exit(1); });
}
