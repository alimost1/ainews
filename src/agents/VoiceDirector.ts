/**
 * VoiceDirector.ts — VoiceDirector Agent
 * Uses edge-tts to generate MP3 audio for each scene.
 */

import * as fs from "fs";
import * as path from "path";
import { logger, CONFIG, readJSON, writeJSON, sleep } from "./shared";
import { MOOD_VOICE_MAP, MOOD_VOICE_MAP_AR } from "../types";
import type { Script, Scene, Mood } from "../types";

const SCRIPT_PATH = path.join(CONFIG.dataDir, "script.json");

async function generateSceneAudio(scene: Scene, outputPath: string): Promise<number> {
  const voiceMap = CONFIG.language === "ar" ? MOOD_VOICE_MAP_AR : MOOD_VOICE_MAP;
  const voiceName = voiceMap[scene.mood as Mood] || (CONFIG.language === "ar" ? "ar-SA-ZariyahNeural" : "en-US-JennyNeural");
  const rawMp3Path = outputPath.replace(".mp3", "_raw.mp3");
  
  logger.agent("VoiceDirector", `Scene ${scene.scene_number} (voice: ${voiceName})...`);

  try {
    const { execSync } = require("child_process");
    const fs = require("fs");
    const path = require("path");
    
    // Write narration text to temp file to avoid shell escaping issues
    const tmpTxtPath = path.join(CONFIG.audioDir, `_tmp_scene_${scene.scene_number}.txt`);
    fs.writeFileSync(tmpTxtPath, scene.narration_text, "utf-8");
    
    // Generate raw MP3 via edge-tts
    execSync(
      `edge-tts --voice "${voiceName}" --rate="+10%" --volume="+20%" -f "${tmpTxtPath}" --write-media "${rawMp3Path}"`,
      { timeout: 60000, stdio: "pipe" }
    );
    
    // Clean up temp text file
    try { fs.unlinkSync(tmpTxtPath); } catch {}

    // Post-process: convert to high-quality normalized AAC
    // - 48kHz stereo, 192kbps
    // - loudnorm filter for consistent volume (broadcast standard)
    // - highpass 80Hz to remove rumble
    execSync(
      `ffmpeg -y -i "${rawMp3Path}" -af "loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=80,lowpass=f=12000" -ar 48000 -ac 2 -b:a 192k "${outputPath}" 2>/dev/null`,
      { timeout: 30000, stdio: "pipe" }
    );

    // Remove raw file
    try { fs.unlinkSync(rawMp3Path); } catch {}

    const stats = fs.statSync(outputPath);
    const durationSeconds = Math.round(stats.size / (192000 / 8));
    const sizeKB = Math.round(stats.size / 1024);
    logger.success(`Scene ${scene.scene_number} audio saved (${sizeKB} KB, ~${durationSeconds}s, HQ AAC)`);
    return durationSeconds;
  } catch (err: any) {
    logger.warn(`TTS failed for scene ${scene.scene_number}: ${err.message?.substring(0, 100)}`);
    fs.writeFileSync(outputPath, Buffer.alloc(44));
    return scene.duration_seconds;
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
