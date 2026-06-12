#!/usr/bin/env python3
"""Generate images for health video scenes using Cloudflare AI.

Prompt engineering: specific visual descriptions with lighting, camera angle, style.
Negative prompt: no humans no faces no people no text no watermark no blurry etc.
"""

import json
import subprocess
import sys
import os
import shutil

PROJECT = "/root/ianews"
IMAGES_DIR = os.path.join(PROJECT, "public/images")
SCRIPT_FILE = os.path.join(PROJECT, "data", "health_script.json")
ENV_FILE = os.path.join(PROJECT, ".env")

def load_env():
    cfg = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line.startswith("#") or not line:
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    cfg[k.strip()] = v.strip()
    return cfg

cfg = load_env()
CF_ACCOUNT = cfg.get("CF_ACCOUNT_ID", "")
CF_TOKEN = cfg.get("CF_API_TOKEN", "")
CF_MODEL = cfg.get("CF_IMAGE_MODEL", "@cf/stabilityai/stable-diffusion-xl-base-1.0")

if not CF_ACCOUNT or not CF_TOKEN:
    print("⚠️ CF_ACCOUNT_ID or CF_API_TOKEN not found in .env", file=sys.stderr)
    sys.exit(1)

print(f"CF Account: {CF_ACCOUNT[:10]}...")
print(f"CF Model: {CF_MODEL}")

os.makedirs(IMAGES_DIR, exist_ok=True)

with open(SCRIPT_FILE, encoding="utf-8") as f:
    script = json.load(f)

# Negative prompt suffix for all images
NEGATIVE_PROMPT = ", no humans no faces no people, no text no watermark no blurry no deformed no illustration no cartoon no anime no painting no drawing"

for scene in script["scenes"]:
    num = scene["scene_number"]
    img_path = os.path.join(IMAGES_DIR, f"health_scene_{num}.png")
    if os.path.exists(img_path) and os.path.getsize(img_path) > 10000:
        print(f"Scene {num}: image exists ✓")
        continue

    prompt = scene.get("image_prompt", "")
    if not prompt:
        print(f"Scene {num}: no prompt, skipping")
        continue

    # Append negative prompt
    full_prompt = prompt + NEGATIVE_PROMPT

    tmp_file = f"/tmp/cf_health_img_{num}.png"

    print(f"Scene {num}: generating ({len(full_prompt)} chars)...")

    # Retry up to 3 times with exponential backoff for 502/503 errors
    success = False
    for attempt in range(3):
        if attempt > 0:
            wait = 15 * attempt
            print(f"  Retry {attempt}/2 (waiting {wait}s)...")
            import time
            time.sleep(wait)

        # Try with 20 steps first, then 16 on retry
        steps = 20 if attempt == 0 else 16
        cmd = [
            "curl", "-s", "-o", tmp_file,
            f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/ai/run/{CF_MODEL}",
            "-H", f"Authorization: Bearer {CF_TOKEN}",
            "-H", "Content-Type: application/json",
            "--data", json.dumps({"prompt": full_prompt, "num_inference_steps": steps}),
        ]

        try:
            subprocess.run(cmd, timeout=120, check=True)
            sz = os.path.getsize(tmp_file)

            if sz >= 10000:
                shutil.copy2(tmp_file, img_path)
                os.unlink(tmp_file)
                print(f"  ✓ {sz // 1024} KB")
                success = True
                break
            else:
                with open(tmp_file, "rb") as f:
                    err = f.read()[:200]
                print(f"  ⚠️ Small/corrupt ({sz}B) — {err}")
        except Exception as e:
            print(f"  ✗ Attempt {attempt+1} failed: {e}")

    if not success:
        print(f"  ✗ Scene {num}: all retries exhausted")

print("\nDone.")
