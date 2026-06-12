#!/usr/bin/env python3
"""Generate a single image post for Facebook using Cloudflare AI + FB Graph API.

Usage:
    python3 gen_image_post.py --page <page_id> --topic <topic> --prompt <image_prompt> --caption <caption> [--hashtags <tags>]

Posts directly to Facebook Page via Graph API multipart upload.
"""

import argparse
import json
import os
import subprocess
import sys
import time

PROJECT = "/root/ianews"
ENV_FILE = os.path.join(PROJECT, ".env")
TOKENS_FILE = os.path.join(PROJECT, "data", "fb_tokens.json")
OUTPUT_DIR = os.path.join(PROJECT, "output")


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


def load_tokens():
    with open(TOKENS_FILE, encoding="utf-8") as f:
        return json.load(f)


def get_page_token(page_id, tokens_data):
    """Find page token for given page ID."""
    # Check current page
    if tokens_data.get("pageId") == str(page_id):
        return tokens_data["pageToken"]
    # Search in allPages
    for page in tokens_data.get("allPages", []):
        if page["id"] == str(page_id):
            return page["access_token"]
    return None


def generate_image(prompt, output_path, cfg, num_steps=20):
    """Generate image via Cloudflare Workers AI."""
    cf_account = cfg.get("CF_ACCOUNT_ID", "")
    cf_token = cfg.get("CF_API_TOKEN", "")
    cf_model = cfg.get("CF_IMAGE_MODEL", "@cf/stabilityai/stable-diffusion-xl-base-1.0")

    if not cf_account or not cf_token:
        print("❌ CF_ACCOUNT_ID or CF_API_TOKEN not found in .env", file=sys.stderr)
        sys.exit(1)

    negative_prompt = "illustration, drawing, painting, cartoon, sketch, inked, anime, vector art, clipart, crayon, watercolor, doodle, comic, manga, stylized, unrealistic, plastic, blurry, low quality, deformed, text, watermark, logo, humans, faces, people"

    payload = {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "width": 1080,
        "height": 1080,
        "num_inference_steps": num_steps,
    }

    tmp_file = "/tmp/cf_img_post.png"
    if os.path.exists(tmp_file):
        os.remove(tmp_file)

    cmd = [
        "curl", "-s", "-o", tmp_file, "-w", "\n%{http_code}",
        f"https://api.cloudflare.com/client/v4/accounts/{cf_account}/ai/run/{cf_model}",
        "-H", f"Authorization: Bearer {cf_token}",
        "-H", "Content-Type: application/json",
        "-d", json.dumps(payload),
    ]

    print(f"🎨 Generating image with CF AI (steps={num_steps})...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

    # Parse HTTP code from stderr/stdout (curl -w appends to stdout, but -s sends to stderr)
    # Actually curl -w goes to stdout; since we use -o, the file gets the body, stdout gets the code
    http_code_str = result.stdout.strip().split("\n")[-1] if result.stdout.strip() else "000"
    try:
        http_code_int = int(http_code_str)
    except ValueError:
        http_code_int = 200  # assume OK if we can't parse

    # Handle 502/503/504 — signal caller to retry with backoff
    if http_code_int in (502, 503, 504):
        print(f"⚠️ CF returned HTTP {http_code_int} (origin down)")
        return False

    if not os.path.exists(tmp_file):
        print(f"❌ No output file. curl stderr: {result.stderr[:200]}", file=sys.stderr)
        return False

    size = os.path.getsize(tmp_file)

    # Check for error response (104 bytes = JSON error)
    if size < 500:
        with open(tmp_file, "rb") as f:
            content = f.read()
        try:
            err = json.loads(content)
            errors = err.get("errors", [])
            if errors:
                err_code = errors[0].get("code", 0)
                err_msg = errors[0].get("message", "")
                print(f"❌ CF Error {err_code}: {err_msg}", file=sys.stderr)
                if err_code == 10000:
                    print("⚠️ Token expired or account ID wrong", file=sys.stderr)
                return False
        except json.JSONDecodeError:
            pass
        print(f"❌ File too small ({size} bytes), likely error", file=sys.stderr)
        return False

    # Verify image is not mostly black
    verify_cmd = [
        "/usr/local/lib/hermes-agent/venv/bin/python3", "-c",
        f"from PIL import Image; import numpy as np; "
        f"img=Image.open('{tmp_file}').convert('RGB'); "
        f"arr=np.array(img); "
        f"print(f'size={{arr.shape}}, avg={{arr.mean():.1f}}') "
        f"if arr.mean() > 10 else exit(1)"
    ]
    try:
        v = subprocess.run(verify_cmd, capture_output=True, text=True, timeout=15)
        if v.returncode != 0:
            print(f"⚠️ Image appears black (avg pixel too low): {v.stdout.strip()}", file=sys.stderr)
            return False
        print(f"✅ {v.stdout.strip()}")
    except Exception as e:
        print(f"⚠️ Could not verify image: {e}")

    # Copy to output
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    subprocess.run(["cp", tmp_file, output_path], check=True)
    print(f"✅ Image saved: {output_path} ({size} bytes)")
    return True


def optimize_image(image_path, max_size_kb=500):
    """Optimize JPEG for Facebook upload — compress if too large."""
    size_kb = os.path.getsize(image_path) / 1024
    if size_kb <= max_size_kb:
        return

    print(f"📐 Optimizing: {size_kb:.0f}KB → target {max_size_kb}KB...")
    quality = 85
    while size_kb > max_size_kb and quality > 30:
        cmd = [
            "/usr/local/lib/hermes-agent/venv/bin/python3", "-c",
            f"from PIL import Image; "
            f"img=Image.open('{image_path}').convert('RGB'); "
            f"img.save('{image_path}', 'JPEG', quality={quality}, optimize=True); "
            f"import os; print(os.path.getsize('{image_path}') // 1024)"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            size_kb = int(result.stdout.strip())
            print(f"  quality={quality}: {size_kb}KB")
        quality -= 15

    if size_kb <= max_size_kb:
        print(f"✅ Optimized to {size_kb}KB")


def get_instagram_account(page_id, page_token):
    """Get Instagram business account linked to a Facebook Page."""
    cmd = [
        "curl", "-s",
        f"https://graph.facebook.com/v21.0/{page_id}?fields=instagram_business_account&access_token={page_token}"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    try:
        resp = json.loads(result.stdout)
        ig = resp.get("instagram_business_account")
        if ig:
            return ig.get("id")
    except:
        pass
    return None


def post_to_instagram(ig_account_id, page_token, image_path, caption):
    """Post image to Instagram via Graph API (two-step: create container -> publish)."""
    # Step 1: Create media container
    optimize_image(image_path, max_size_kb=500)

    # For Instagram, we need a publicly accessible URL. Upload image to a temp location
    # and use a data URL approach, or use the image URL method.
    # Instagram Graph API requires a PUBLIC URL for the image.
    # We'll use the Facebook Page's hosted image approach:
    # First upload to FB as unpublished, then use that URL.

    # Alternative: Use the Instagram Container API with image_url
    # Since we can't easily host the image publicly, we'll try the direct upload approach
    # by first creating a FB unpublished photo and using its URL.

    # Actually, the simplest working approach: upload image to FB page as published photo,
    # get the photo URL, then use it for Instagram. But that double-posts.

    # Better approach: Use the Instagram Business Container API with a base64 data URI
    # or use the multipart upload to Instagram directly.

    # The most reliable method: Create container with image_url pointing to a public URL.
    # We'll upload the image to the FB page as an UNPUBLISHED photo first.

    print(f"📤 Creating Instagram media container for IG {ig_account_id}...")

    # Step 1a: Upload unpublished photo to FB page to get a public URL
    fb_url = f"https://graph.facebook.com/v21.0/{ig_account_id}/photos"
    boundary = "----iAnewsIG" + str(int(time.time()))

    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"access_token\"\r\n\r\n{page_token}\r\n")
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"published\"\r\n\r\nfalse\r\n")
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"source\"; filename=\"ig_post.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n")

    header = "".join(parts).encode("utf-8")
    with open(image_path, "rb") as f:
        file_data = f.read()
    footer = f"\r\n--{boundary}--\r\n".encode("utf-8")
    body = header + file_data + footer

    body_file = "/tmp/fb_ig_upload.bin"
    with open(body_file, "wb") as f:
        f.write(body)

    cmd = [
        "curl", "-s", "-X", "POST", fb_url,
        "-H", f"Content-Type: multipart/form-data; boundary={boundary}",
        "--data-binary", f"@{body_file}",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

    image_url = None
    try:
        resp = json.loads(result.stdout)
        if "id" in resp:
            photo_id = resp["id"]
            # Get the photo URL
            url_cmd = ["curl", "-s",
                       f"https://graph.facebook.com/v21.0/{photo_id}?fields=images&access_token={page_token}"]
            url_result = subprocess.run(url_cmd, capture_output=True, text=True, timeout=15)
            url_resp = json.loads(url_result.stdout)
            images = url_resp.get("images", [])
            if images:
                image_url = images[0].get("source")
    except Exception as e:
        print(f"⚠️ Could not get image URL: {e}", file=sys.stderr)

    if not image_url:
        # Fallback: try direct URL from the upload response
        print("⚠️ Could not get public image URL, trying alternative method...", file=sys.stderr)
        return False

    # Step 2: Create Instagram media container
    container_url = f"https://graph.facebook.com/v21.0/{ig_account_id}/media"
    container_params = {
        "image_url": image_url,
        "caption": caption,
        "access_token": page_token,
    }

    cmd = [
        "curl", "-s", "-X", "POST", container_url,
        "-H", "Content-Type: application/json",
        "-d", json.dumps(container_params),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

    try:
        resp = json.loads(result.stdout)
        creation_id = resp.get("id")
        if not creation_id:
            err = resp.get("error", {})
            print(f"❌ IG container error: {err.get('message', resp)}", file=sys.stderr)
            return False
        print(f"📦 Container created: {creation_id}")
    except Exception as e:
        print(f"❌ IG container parse error: {e}", file=sys.stderr)
        return False

    # Step 3: Publish the container
    publish_url = f"https://graph.facebook.com/v21.0/{ig_account_id}/media_publish"
    publish_params = {
        "creation_id": creation_id,
        "access_token": page_token,
    }

    # Wait a bit for Instagram to process
    print("⏳ Waiting for Instagram to process...")
    time.sleep(5)

    cmd = [
        "curl", "-s", "-X", "POST", publish_url,
        "-H", "Content-Type: application/json",
        "-d", json.dumps(publish_params),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

    try:
        resp = json.loads(result.stdout)
        ig_post_id = resp.get("id")
        if ig_post_id:
            print(f"✅ Instagram posted! Post ID: {ig_post_id}")
            return True
        else:
            err = resp.get("error", {})
            print(f"❌ IG publish error: {err.get('message', resp)}", file=sys.stderr)
            return False
    except Exception as e:
        print(f"❌ IG publish parse error: {e}", file=sys.stderr)
        return False


def post_to_facebook(page_id, page_token, image_path, message):
    """Post image to Facebook Page via Graph API multipart upload."""
    # Optimize image before upload
    optimize_image(image_path, max_size_kb=500)

    url = f"https://graph.facebook.com/v21.0/{page_id}/photos"

    boundary = "----iAnewsPost" + str(int(time.time()))

    # Build multipart body
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"access_token\"\r\n\r\n{page_token}\r\n")
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"message\"\r\n\r\n{message}\r\n")
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"published\"\r\n\r\ntrue\r\n")
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"source\"; filename=\"post.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n")

    header = "".join(parts).encode("utf-8")
    with open(image_path, "rb") as f:
        file_data = f.read()
    footer = f"\r\n--{boundary}--\r\n".encode("utf-8")

    body = header + file_data + footer

    # Write body to temp file to avoid null byte issues with subprocess
    body_file = "/tmp/fb_post_body.bin"
    with open(body_file, "wb") as f:
        f.write(body)

    cmd = [
        "curl", "-s", "-X", "POST", url,
        "-H", f"Content-Type: multipart/form-data; boundary={boundary}",
        "--data-binary", f"@{body_file}",
    ]

    print(f"📤 Posting to Facebook page {page_id}...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

    try:
        resp = json.loads(result.stdout)
        if "id" in resp or "post_id" in resp:
            post_id = resp.get("post_id", resp.get("id", ""))
            print(f"✅ Posted successfully! Post ID: {post_id}")
            return True
        elif "error" in resp:
            err = resp["error"]
            print(f"❌ FB Error {err.get('code', '')}: {err.get('message', '')}", file=sys.stderr)
            return False
        else:
            print(f"⚠️ Unexpected response: {result.stdout[:200]}", file=sys.stderr)
            return False
    except json.JSONDecodeError:
        print(f"❌ Invalid response: {result.stdout[:200]}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="Generate image + post to Facebook and/or Instagram")
    parser.add_argument("--page", required=True, help="Facebook page ID")
    parser.add_argument("--prompt", required=True, help="Image generation prompt (English)")
    parser.add_argument("--caption", required=True, help="Post caption (Arabic)")
    parser.add_argument("--hashtags", default="", help="Hashtags (space-separated)")
    parser.add_argument("--output", default=os.path.join(OUTPUT_DIR, "image_post.jpg"))
    parser.add_argument("--steps", type=int, default=20, help="CF inference steps (max 20)")
    parser.add_argument("--instagram", action="store_true", help="Also post to Instagram")
    parser.add_argument("--ig-account", default=None, help="Instagram account ID (auto-detected if not provided)")
    args = parser.parse_args()

    # Load config
    cfg = load_env()
    tokens_data = load_tokens()

    # Get page token
    page_token = get_page_token(args.page, tokens_data)
    if not page_token:
        print(f"❌ No token found for page {args.page}", file=sys.stderr)
        sys.exit(1)

    page_name = "مستقبل ذكي" if args.page == "227928873960321" else "Mawtini-موطني" if args.page == "507558506002636" else args.page
    print(f"📄 Page: {page_name} ({args.page})")

    # Generate image with retry on 502/503
    success = generate_image(args.prompt, args.output, cfg, num_steps=args.steps)
    if not success:
        for attempt in range(2):
            wait = 20 * (attempt + 1)
            print(f"🔄 Retry attempt {attempt+1}/2 (waiting {wait}s)...")
            time.sleep(wait)
            success = generate_image(args.prompt, args.output, cfg, num_steps=max(12, args.steps - 4*(attempt+1)))
            if success:
                break
    if not success:
        print("❌ Image generation failed after all retries", file=sys.stderr)
        sys.exit(1)

    # Build message
    message = args.caption.strip()
    if args.hashtags:
        message += "\n\n" + args.hashtags.strip()

    # Post to Facebook
    success = post_to_facebook(args.page, page_token, args.output, message)
    if not success:
        sys.exit(1)

    # Post to Instagram if requested
    if args.instagram:
        ig_account = args.ig_account
        if not ig_account:
            ig_account = get_instagram_account(args.page, page_token)
        if not ig_account:
            # Try with user token
            user_token = tokens_data.get("userToken")
            if user_token:
                ig_account = get_instagram_account(args.page, user_token)

        if ig_account:
            print(f"📸 Instagram account found: {ig_account}")
            # For Instagram, caption + hashtags work well
            ig_caption = message
            post_to_instagram(ig_account, page_token, args.output, ig_caption)
        else:
            print("⚠️ No Instagram business account linked to this page.")
            print("   To enable IG posting: connect an Instagram Business account to this FB Page")
            print("   in Facebook Page Settings > Instagram, then re-authorize the app.")

    print("🎉 Done!")


if __name__ == "__main__":
    main()
