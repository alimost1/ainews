#!/usr/bin/env python3
"""Upload a video to YouTube using stored OAuth2 refresh token."""
import os, sys, json, time
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from googleapiclient.errors import HttpError

TOKEN_FILE = '/root/.config/google/youtube_token.json'
CLIENT_SECRET_FILE = '/root/.config/google/client_secret.json'
SCOPES = ['https://www.googleapis.com/auth/youtube.upload']

def get_creds():
    """Load and refresh credentials."""
    if not os.path.exists(TOKEN_FILE):
        raise FileNotFoundError(f"Token file not found: {TOKEN_FILE}. Run youtube_auth.py first.")
    
    creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open(TOKEN_FILE, 'w') as f:
            f.write(creds.to_json())
    
    return creds

def upload_video(video_path, title, description, category_id='28', privacy='public', tags=None):
    """
    Upload video to YouTube.
    category_id: 28 = Science & Technology, 22 = People & Blogs, 25 = News & Politics
    privacy: public, unlisted, private
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")
    
    creds = get_creds()
    youtube = build('youtube', 'v3', credentials=creds)
    
    body = {
        'snippet': {
            'title': title[:100],  # YouTube max 100 chars
            'description': description[:5000],
            'tags': tags or [],
            'categoryId': category_id,
        },
        'status': {
            'privacyStatus': privacy,
            'selfDeclaredMadeForKids': False,
        }
    }
    
    print(f"📤 Uploading to YouTube: {title[:50]}...")
    print(f"   File: {video_path} ({os.path.getsize(video_path)/1024/1024:.1f} MB)")
    
    media = MediaFileUpload(
        video_path,
        mimetype='video/mp4',
        resumable=True
    )
    
    request = youtube.videos().insert(
        part='snippet,status',
        body=body,
        media_body=media
    )
    
    # Resumable upload with progress
    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            pct = int(status.progress() * 100)
            print(f"   📊 Upload: {pct}%")
    
    video_id = response['id']
    url = f"https://www.youtube.com/watch?v={video_id}"
    print(f"✅ YouTube upload complete!")
    print(f"   Video ID: {video_id}")
    print(f"   URL: {url}")
    
    return {'video_id': video_id, 'url': url}

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 youtube_upload.py <video_path> [title] [description_file]")
        sys.exit(1)
    
    video_path = sys.argv[1]
    title = sys.argv[2] if len(sys.argv) > 2 else 'iAnews Video'
    desc_file = sys.argv[3] if len(sys.argv) > 3 else None
    
    description = ''
    if desc_file and os.path.exists(desc_file):
        with open(desc_file, 'r', encoding='utf-8') as f:
            description = f.read()
    
    # Default tags for iAnews
    tags = ['iAnews', 'أخبار', 'ذكاء_اصطناعي', 'AI', 'أخبار_التقنية', 'المغرب', 'عربي']
    
    result = upload_video(video_path, title, description, tags=tags)
    print(f"\n🎬 Done! {result['url']}")
