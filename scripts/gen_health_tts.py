#!/usr/bin/env python3
"""Generate Arabic TTS audio for health video scenes using edge-tts.

Usage:
  python3 gen_health_tts.py
"""
import json, os, subprocess

PROJECT = "/root/ianews"
AUDIO_DIR = os.path.join(PROJECT, "public/audio")
SCRIPT_FILE = os.path.join(PROJECT, "data", "health_script.json")
TTS_BIN = "/usr/local/lib/hermes-agent/venv/bin/edge-tts"

os.makedirs(AUDIO_DIR, exist_ok=True)

if not os.path.exists(SCRIPT_FILE):
    print(f"✗ Script not found: {SCRIPT_FILE}")
    exit(1)

with open(SCRIPT_FILE, encoding="utf-8") as f:
    script = json.load(f)

for scene in script["scenes"]:
    num = scene["scene_number"]
    aud_path = os.path.join(AUDIO_DIR, f"health_scene_{num}.wav")

    if os.path.exists(aud_path) and os.path.getsize(aud_path) > 10000:
        print(f"Scene {num}: audio exists ✓")
        continue

    text = scene.get("narration_text", "").strip()
    if not text:
        print(f"Scene {num}: no text, skipping")
        continue

    mood = scene.get("mood", "neutral")
    voice = "ar-SA-ZariyahNeural" if mood in ("excited", "hopeful") else "ar-SA-HamedNeural"

    try:
        result = subprocess.run(
            [TTS_BIN, "--voice", voice, "--rate", "+15%", "--text", text, "--write-media", aud_path],
            capture_output=True, text=True, timeout=60
        )
        if os.path.exists(aud_path):
            sz = os.path.getsize(aud_path)
            print(f"Scene {num}: ✓ {sz//1024}KB ({voice})")
        else:
            print(f"Scene {num}: FAILED — {result.stderr[:100]}")
    except Exception as e:
        print(f"Scene {num}: error — {e}")

print("\nTTS generation complete.")
