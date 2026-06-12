#!/usr/bin/env python3
"""Generate images (CF SDXL) + audio (edge-tts) in parallel for all scenes."""
import json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed

PYTHON = "/usr/local/lib/hermes-agent/venv/bin/python3"
NODE = "/root/.local/bin/node"
PROJECT = "/root/ianews"
IMAGES = os.path.join(PROJECT, "public/images")
AUDIO = os.path.join(PROJECT, "public/audio")
OUTPUT = os.path.join(PROJECT, "output")

os.makedirs(IMAGES, exist_ok=True)
os.makedirs(AUDIO, exist_ok=True)
os.makedirs(OUTPUT, exist_ok=True)

# Load script
with open(os.path.join(PROJECT, "data/script.json"), "r") as f:
    script = json.load(f)

scenes = script["scenes"]
print(f"🎬 Generating assets for: {script['title']}")
print(f"   {len(scenes)} scenes, parallel workers\n")

# --- Image generation via CF SDXL ---
# Load from .env file (secrets should NOT be hardcoded)
import pathlib
_env_path = pathlib.Path(__file__).parent / ".env"
_env = {}
if _env_path.exists():
    for _line in _env_path.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            _env[_k.strip()] = _v.strip()

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", _env.get("CF_ACCOUNT_ID", ""))
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", _env.get("CF_API_TOKEN", ""))
CF_IMAGE_MODEL = os.environ.get("CF_IMAGE_MODEL", _env.get("CF_IMAGE_MODEL", "@cf/stabilityai/stable-diffusion-xl-base-1.0"))

def generate_image(scene):
    num = scene["scene_number"]
    prompt = scene["image_prompt"]
    out_path = os.path.join(IMAGES, f"scene_{num}.png")
    
    for attempt in range(1, 4):
        try:
            print(f"  🖼️  Scene {num}: CF SDXL (attempt {attempt}/3)...")
            url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/run/{CF_IMAGE_MODEL}"
            
            result = subprocess.run(
                ["curl", "-s", "-X", "POST", url,
                 "-H", f"Authorization: Bearer {CF_API_TOKEN}",
                 "-H", "Content-Type: application/json",
                 "-d", json.dumps({"prompt": prompt, "width": 768, "height": 1344, "num_steps": 20, "guidance_scale": 8.0}),
                 "--max-time", "120"],
                capture_output=True, timeout=130
            )
            
            if result.returncode != 0:
                print(f"  ❌ Scene {num}: curl failed (attempt {attempt})")
                time.sleep(5)
                continue
            
            data = result.stdout
            if len(data) < 10000:
                print(f"  ⚠️  Scene {num}: response too small ({len(data)} bytes), retrying...")
                time.sleep(5)
                continue
            
            # Check PNG magic bytes
            if data[:2] == b'\x89\x50':
                with open(out_path, 'wb') as f:
                    f.write(data)
                size_kb = os.path.getsize(out_path) / 1024
                print(f"  ✅ Scene {num}: image saved ({size_kb:.0f} KB)")
                return True
            else:
                print(f"  ⚠️  Scene {num}: not PNG (magic: {data[:4].hex()}), retrying...")
                time.sleep(5)
        except Exception as e:
            print(f"  ❌ Scene {num}: error: {e}")
            time.sleep(5)
    
    print(f"  ❌ Scene {num}: all attempts failed")
    return False

# --- Audio generation via edge-tts ---
VOICES = {1: "ar-SA-HamedNeural", 2: "ar-SA-ZariyahNeural", 3: "ar-SA-HamedNeural",
          4: "ar-SA-ZariyahNeural", 5: "ar-SA-HamedNeural", 6: "ar-SA-ZariyahNeural",
          7: "ar-SA-HamedNeural", 8: "ar-SA-ZariyahNeural", 9: "ar-SA-HamedNeural"}

def generate_audio(scene):
    num = scene["scene_number"]
    text = scene["narration_text"]
    voice = VOICES.get(num, "ar-SA-HamedNeural")
    out_path = os.path.join(AUDIO, f"scene_{num}.wav")
    
    try:
        print(f"  🔊 Scene {num}: TTS ({voice})...")
        result = subprocess.run(
            [PYTHON, "-c", f"""
import asyncio
import edge_tts

async def main():
    communicate = edge_tts.Communicate('{text}', '{voice}', rate='+10%')
    await communicate.save('{out_path}')
    print('done')

asyncio.run(main())
"""],
            capture_output=True, timeout=60,
            env={**os.environ, "PATH": "/usr/local/lib/hermes-agent/venv/bin:/usr/bin:/bin"}
        )
        
        if os.path.exists(out_path) and os.path.getsize(out_path) > 1000:
            size_kb = os.path.getsize(out_path) / 1024
            print(f"  ✅ Scene {num}: audio saved ({size_kb:.0f} KB)")
            return True
        else:
            print(f"  ❌ Scene {num}: audio file missing or too small")
            return False
    except Exception as e:
        print(f"  ❌ Scene {num}: TTS error: {e}")
        return False

# --- Run in parallel ---
start = time.time()

with ThreadPoolExecutor(max_workers=6) as executor:
    img_futures = {executor.submit(generate_image, s): s for s in scenes}
    aud_futures = {executor.submit(generate_audio, s): s for s in scenes}
    
    img_results = {}
    aud_results = {}
    
    for future in as_completed(img_futures):
        scene = img_futures[future]
        img_results[scene["scene_number"]] = future.result()
    
    for future in as_completed(aud_futures):
        scene = aud_futures[future]
        aud_results[scene["scene_number"]] = future.result()

elapsed = time.time() - start
print(f"\n⏱️  Generation complete in {elapsed:.0f}s")
print(f"   Images: {sum(img_results.values())}/{len(scenes)} success")
print(f"   Audio:  {sum(aud_results.values())}/{len(scenes)} success")

# Verify
for s in scenes:
    num = s["scene_number"]
    img_ok = os.path.exists(os.path.join(IMAGES, f"scene_{num}.png"))
    aud_ok = os.path.exists(os.path.join(AUDIO, f"scene_{num}.wav"))
    status = "✅" if (img_ok and aud_ok) else "❌"
    print(f"   {status} Scene {num}: img={'Y' if img_ok else 'N'} aud={'Y' if aud_ok else 'N'}")
