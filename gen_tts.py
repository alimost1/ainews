#!/usr/bin/env python3
"""Generate TTS audio for each scene using Python edge_tts API"""
import asyncio
import edge_tts
import json
import os
import subprocess
import sys

PROJECT = "/root/ianews"
SCRIPT_PATH = os.path.join(PROJECT, "data", "script.json")
AUDIO_DIR = os.path.join(PROJECT, "public", "audio")

os.makedirs(AUDIO_DIR, exist_ok=True)

with open(SCRIPT_PATH, "r", encoding="utf-8") as f:
    script = json.load(f)

# Voice mapping for Arabic
VOICE_MAP = {
    "excited": "ar-SA-HamedNeural",
    "cheerful": "ar-SA-HamedNeural",
    "hopeful": "ar-SA-ZariyahNeural",
    "friendly": "ar-SA-ZariyahNeural",
    "neutral": "ar-SA-ZariyahNeural",
    "serious": "ar-SA-HamedNeural",
    "calm": "ar-SA-ZariyahNeural",
    "urgent": "ar-SA-HamedNeural", 
    "sad": "ar-SA-ZariyahNeural",
    "angry": "ar-SA-HamedNeural",
}

async def generate_scene(scene):
    num = scene["scene_number"]
    text = scene["narration_text"]
    emotion = scene.get("voice_emotion", "friendly")
    voice = VOICE_MAP.get(emotion, "ar-SA-ZariyahNeural")
    
    raw_path = os.path.join(AUDIO_DIR, f"_raw_scene_{num}.mp3")
    out_path = os.path.join(AUDIO_DIR, f"scene_{num}.mp3")
    
    print(f"🎙️ Scene {num}: voice={emotion} ({voice})")
    print(f"   Text: {text[:60]}...")
    
    try:
        await edge_tts.Communicate(text, voice, rate="+10%", volume="+20%").save(raw_path)
        print(f"   Raw: {os.path.getsize(raw_path)} bytes")
    except Exception as e:
        print(f"   ✗ TTS failed: {e}")
        return None
    
    # Post-process with ffmpeg: normalize, 48kHz, 192k
    try:
        subprocess.run([
            "ffmpeg", "-y", "-i", raw_path,
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=80,lowpass=f=12000",
            "-ar", "48000", "-ac", "2", "-b:a", "192k",
            out_path
        ], capture_output=True, timeout=30)
        
        # Clean up raw
        try: os.unlink(raw_path)
        except: pass
        
        if os.path.exists(out_path):
            dur = get_duration(out_path)
            sz = os.path.getsize(out_path)
            print(f"   ✅ {out_path}: {sz//1024}KB, {dur:.1f}s")
            return {"path": out_path, "duration": dur}
        else:
            print(f"   ✗ Output not created")
            return None
    except Exception as e:
        print(f"   ✗ FFmpeg failed: {e}")
        return None

def get_duration(path):
    try:
        r = subprocess.run([
            "ffprobe", "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "csv=p=0", path
        ], capture_output=True, text=True, timeout=10)
        return float(r.stdout.strip())
    except:
        return 0.0

async def main():
    print(f"🎬 Generating TTS for {len(script['scenes'])} scenes...")
    results = {}
    
    for scene in script["scenes"]:
        result = await generate_scene(scene)
        if result:
            results[str(scene["scene_number"])] = result
        await asyncio.sleep(1)
    
    # Update script.json with audio paths and durations
    for scene in script["scenes"]:
        key = str(scene["scene_number"])
        if key in results:
            scene["audio_path"] = results[key]["path"]
            scene["audio_duration"] = results[key]["duration"]
    
    with open(SCRIPT_PATH, "w", encoding="utf-8") as f:
        json.dump(script, f, ensure_ascii=False, indent=2)
    
    print(f"\n✅ TTS done. {len(results)}/{len(script['scenes'])} scenes generated.")
    print(f"Script updated: {SCRIPT_PATH}")

asyncio.run(main())
