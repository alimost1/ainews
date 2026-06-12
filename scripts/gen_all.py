#!/usr/bin/env python3
"""Parallel image + audio generation for iAnews videos.

TTS: edge-tts (free, no setup)
  - Arabic voices: ar-SA-HamedNeural (male), ar-SA-ZariyahNeural (female)
  - Odd scenes: Hamed (male), Even scenes: Zariyah (female)
"""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor, as_completed
import time

PROJECT = "/root/ianews"
SCRIPT_PATH = f"{PROJECT}/data/script.json"

# Load script
with open(SCRIPT_PATH, "r", encoding="utf-8") as f:
    script = json.load(f)

# Load CF credentials
cf_account = None
cf_token = None
cf_model = "@cf/stabilityai/stable-diffusion-xl-base-1.0"
with open(f"{PROJECT}/.env", "r") as f:
    for line in f:
        line = line.strip()
        if line.startswith("CF_ACCOUNT_ID="):
            cf_account = line.split("=", 1)[1]
        elif line.startswith("CF_API_TOKEN="):
            cf_token = line.split("=", 1)[1]
        elif line.startswith("CF_IMAGE_MODEL="):
            cf_model = line.split("=", 1)[1]

print(f"CF Account: {cf_account[:8]}...")
print(f"CF Model: {cf_model}")
print(f"Scenes: {len(script['scenes'])}")

TTS_BIN = "/usr/local/lib/hermes-agent/venv/bin/edge-tts"

def get_voice(mood, scene_num):
    """Alternate voices: odd=Hamed(male), even=Zariyah(female)"""
    if scene_num % 2 == 1:
        return "ar-SA-HamedNeural"
    else:
        return "ar-SA-ZariyahNeural"

def generate_image(scene):
    """Generate image via Cloudflare Workers AI"""
    sn = scene["scene_number"]
    prompt = scene["image_prompt"]
    out_path = f"{PROJECT}/public/images/scene_{sn}.png"

    if os.path.exists(out_path) and os.path.getsize(out_path) > 100000:
        print(f"  [IMG {sn}] Already exists, skipping")
        return sn, True

    print(f"  [IMG {sn}] Generating: {prompt[:60]}...")

    import urllib.request

    # Negative prompt to avoid common SDXL artifacts
    neg = ", no humans no faces no people, no text no watermark no blurry no deformed no illustration no cartoon no anime"
    full_prompt = prompt + neg

    url = f"https://api.cloudflare.com/client/v4/accounts/{cf_account}/ai/run/{cf_model}"
    data = json.dumps({
        "prompt": full_prompt, "num_steps": 20, "guidance_scale": 8.0,
        "width": 768, "height": 1344
    }).encode()

    req = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Bearer {cf_token}", "Content-Type": "application/json"
    }, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()

        content_type = resp.headers.get("Content-Type", "")
        if "json" in content_type:
            result = json.loads(raw)
            print(f"  [IMG {sn}] CF ERROR: {result}")
            return sn, False

        with open(out_path, "wb") as f:
            f.write(raw)

        size = os.path.getsize(out_path)

        # Check for black/corrupt image
        try:
            from PIL import Image
            import io
            img = Image.open(io.BytesIO(raw))
            pixels = list(img.getdata())
            if len(pixels) > 0:
                avg = sum(sum(p[:3]) / 3 for p in pixels[:1000]) / min(1000, len(pixels))
                if avg < 10:
                    print(f"  [IMG {sn}] BLACK IMAGE (avg={avg:.1f}), retrying...")
                    os.remove(out_path)
                    return sn, False
        except Exception:
            pass

        print(f"  [IMG {sn}] OK - {size//1024}KB")
        return sn, True

    except Exception as e:
        print(f"  [IMG {sn}] FAILED: {e}")
        return sn, False

def generate_audio(scene):
    """Generate TTS audio via edge-tts"""
    sn = scene["scene_number"]
    text = scene["narration_text"]
    voice = get_voice(scene.get("mood", "neutral"), sn)
    out_path = f"{PROJECT}/public/audio/scene_{sn}.wav"

    if os.path.exists(out_path) and os.path.getsize(out_path) > 10000:
        print(f"  [TTS {sn}] Already exists, skipping")
        return sn, True

    print(f"  [TTS {sn}] {voice}...")

    try:
        result = subprocess.run(
            [TTS_BIN, "--voice", voice, "--rate", "+15%", "--text", text, "--write-media", out_path],
            capture_output=True, text=True, timeout=60
        )
        if result.returncode != 0:
            print(f"  [TTS {sn}] ERROR: {result.stderr[:200]}")
            return sn, False
        size = os.path.getsize(out_path)
        print(f"  [TTS {sn}] OK - {size//1024}KB")
        return sn, True
    except Exception as e:
        print(f"  [TTS {sn}] FAILED: {e}")
        return sn, False

# Run all generation in parallel
print("\n=== Starting parallel generation ===\n")
start = time.time()

img_results = {}
audio_results = {}

with ThreadPoolExecutor(max_workers=6) as executor:
    futures = {}
    for scene in script["scenes"]:
        f = executor.submit(generate_image, scene)
        futures[f] = ("img", scene["scene_number"])
    for scene in script["scenes"]:
        f = executor.submit(generate_audio, scene)
        futures[f] = ("audio", scene["scene_number"])

    for future in as_completed(futures):
        kind, sn = futures[future]
        try:
            scene_num, success = future.result()
            if kind == "img":
                img_results[scene_num] = success
            else:
                audio_results[scene_num] = success
        except Exception as e:
            print(f"  [{kind} {sn}] Exception: {e}")
            if kind == "img":
                img_results[sn] = False
            else:
                audio_results[sn] = False

elapsed = time.time() - start
print(f"\n=== Generation complete in {elapsed:.1f}s ===")
print(f"Images: {sum(img_results.values())}/{len(img_results)} OK")
print(f"Audio:  {sum(audio_results.values())}/{len(audio_results)} OK")

# Retry failed with exponential backoff
failed_imgs = [sn for sn, ok in img_results.items() if not ok]
if failed_imgs:
    import time as _time
    for attempt in range(3):
        still_failed = [sn for sn in failed_imgs if not img_results.get(sn, False)]
        if not still_failed:
            break
        wait = 15 * (attempt + 1)
        print(f"\nRetry attempt {attempt+1}/3 for {len(still_failed)} failed images (waiting {wait}s)...")
        _time.sleep(wait)
        for scene in script["scenes"]:
            if scene["scene_number"] in still_failed:
                sn, ok = generate_image(scene)
                img_results[sn] = ok

failed_audio = [sn for sn, ok in audio_results.items() if not ok]
if failed_audio:
    print(f"\nRetrying {len(failed_audio)} failed audio...")
    for scene in script["scenes"]:
        if scene["scene_number"] in failed_audio:
            sn, ok = generate_audio(scene)
            audio_results[sn] = ok

print(f"\n=== Final Results ===")
all_ok = all(img_results.values()) and all(audio_results.values())
print(f"Images: {sum(img_results.values())}/{len(img_results)} OK")
print(f"Audio:  {sum(audio_results.values())}/{len(audio_results)} OK")
print(f"Overall: {'SUCCESS' if all_ok else 'PARTIAL FAILURES'}")
