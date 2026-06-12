#!/usr/bin/env python3
"""Fetch Arabic health news from RSS feeds and generate script.json for video builder."""

import json
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
import re
import os
import sys
import random

OUTPUT_DIR = "/root/ianews/data"
SCRIPT_FILE = os.path.join(OUTPUT_DIR, "health_script.json")

# Working RSS feeds (verified)
RSS_FEEDS = [
    ("https://www.aljazeera.net/aljazeerarss/a7c186be-1baa-4571-a61d-92e46e67ea94/73d0e1b4-532f-45ef-b135-bfdff8b8cab9", "Aljazeera"),
    ("https://feeds.bbci.co.uk/arabic/rss.xml", "BBC Arabic"),
    ("https://www.france24.com/ar/rss", "France24 Arabic"),
    ("https://www.dw.com/ar/rss-all", "DW Arabic"),
    ("https://arabic.rt.com/rss/", "RT Arabic"),
    ("https://www.voanews.com/api/zmoAyeuykutey", "VOA Arabic"),
]

# Health keywords for filtering
HEALTH_KEYWORDS = [
    "صحة", "طب", "مرض", "علاج", "دواء", "مستشفى", "طبيب", "لقاح", "فيروس",
    "سرطان", "قلب", "دماغ", "تغذية", "رياضة", "عيون", "أسنان", "عظام", "سكري",
    "ضغط", "وقاية", "وباء", "موجة", "الصحة", "الطبي", "العلاج", "الأدوية",
    "المرض", "الجراحة", "الأشعة", "المختبر", "الصيدلة", "المناعة", "التنفس",
    "الرئة", "الكبد", "الكلى", "المعدة", "الجلد", "الشعر", "الوزن", "الحمية",
    "النوم", "النفسية", "العقل", "الاكتئاب", "القلق", "التوحد", "الزهايمر",
    "الجلطة", "النوبة", "الحساسية", "الربو", "التهاب", "العدوى", "البكتيريا",
    "الورم", "الخلايا", "الجينات", "الفيتامين", "الكالسيوم", "الحديد", "الهرمون",
    "الغدة", "الحمل", "الجنين", "الولادة", "الرضاعة", "الطفل", "المسن",
    "الشيخوخة", "الإعاقة", "التأهيل", "التدخين", "السمنة", "الجوع", "الجفاف",
    "الحرارة", "التسمم", "الإسعافات", "الطوارئ", "التخدير", "نقل الدم",
    "التبرع", "المريض", "المرضى", "المصاب", "الشفاء", "الرعاية", "التأمين الصحي",
    "صحي", "طبية", "طبية", "علاجية", "وقائية", "صحية",
    # English health terms that might appear in Arabic feeds
    "health", "medical", "cancer", "vaccine", "virus", "drug", "therapy",
    "disease", "hospital", "doctor", "treatment", "brain", "heart", "nutrition",
    "mental", "diabetes", "asthma", "alzheimer", "parkinson", "stroke",
]

# Curated health topics as fallback (Arabic)
FALLBACK_HEALTH_TOPICS = [
    {
        "title": "فوائد شرب الماء يوميا للصحة العامة",
        "description": "يساعد شرب كمية كافية من الماء يوميا في تحسين وظائف الجسم والحفاظ على صحة الكلى والبشرة.",
        "image_prompt": "clean water glass with fresh water, healthy lifestyle, clear droplets, blue and white, no humans no faces no people"
    },
    {
        "title": "أهمية النوم الكافي لصحة الجسم",
        "description": "يحتاج الإنسان البالغ من 7 إلى 9 ساعات من النوم يوميا للحفاظ على صحته الجسدية والعقلية.",
        "image_prompt": "peaceful sleep concept, moon and soft stars, calming blue tones, rest and wellness, no humans no faces no people"
    },
    {
        "title": "فوائد التمارين الرياضية المنتظمة",
        "description": "تساعد ممارسة الرياضة بانتظام في تقوية القلب وتحسين المزاج وزيادة الطاقة.",
        "image_prompt": "fitness and wellness concept, running shoes and healthy lifestyle, energetic green and orange, no humans no faces no people"
    },
    {
        "title": "تأثير التغذية السليمة على المناعة",
        "description": "الأغذية الغنية بالفيتامينات والمعادن تعزز جهاز المناعة وتحمي الجسم من الأمراض.",
        "image_prompt": "colorful fresh fruits and vegetables, healthy nutrition, vibrant vitamins concept, green and red, no humans no faces no people"
    },
    {
        "title": "طرق الوقاية من أمراض القلب",
        "description": "يمكن تقليل خطر الإصابة بأمراض القلب من خلال الغذاء الصحي والرياضة والابتعاد عن التدخين.",
        "image_prompt": "healthy heart anatomy with medical glow, red and pink lighting, cardiovascular health, no humans no faces no people"
    },
    {
        "title": "أهمية الفحص الدوري الشامل",
        "description": "يساعد الفحص الطبي المنتظم في الكشف المبكر عن الأمراض وزيادة فرص العلاج الناجح.",
        "image_prompt": "medical checkup concept, stethoscope and health report, clean clinical setting, blue and white, no humans no faces no people"
    },
    {
        "title": "فوائد التأمل والاسترخاء للصحة النفسية",
        "description": "يساعد التأمل المنتظم في تقليل التوتر وتحسين التركيز وتعزيز الصحة النفسية.",
        "image_prompt": "meditation and mindfulness concept, peaceful golden light, calm mind, purple and gold, no humans no faces no people"
    },
    {
        "title": "تأثير التدخين على الجهاز التنفسي",
        "description": "يسبب التدخين أضرارا جسيمة للرئتين ويزيد خطر الإصابة بسرطان الرئة وأمراض الجهاز التنفسي.",
        "image_prompt": "healthy lungs concept with medical overlay, blue red contrast, anti-smoking health, no humans no faces no people"
    },
    {
        "title": "أهمية فيتامين د لصحة العظام",
        "description": "يلعب فيتامين د دورا أساسيا في امتصاص الكالسيوم والحفاظ على قوة العظام والأسنان.",
        "image_prompt": "sunlight and vitamin D concept, bones health, golden sunshine, medical wellness, no humans no faces no people"
    },
    {
        "title": "حافظ على صحة عينيك في العصر الرقمي",
        "description": "قاعدة 20-20-20 تساعد في حماية عينيك من إجهاد الشاشات: كل 20 دقيقة انظر لمسافة 20 قدما لمدة 20 ثانية.",
        "image_prompt": "human eye with digital screen glow, blue light protection, modern technology health, no humans no faces no people"
    },
    {
        "title": "فوائد الأطعمة الغنية بالألياف",
        "description": "تحسن الألياف الغذائية عملية الهضم وتقلل خطر الإصابة بأمراض القلب والسكري.",
        "image_prompt": "high fiber foods, oats and grains and vegetables, digestive health, warm earthy tones, no humans no faces no people"
    },
    {
        "title": "أهمية صحة الفم والأسنان للجسم",
        "description": "ترتبط صحة الفم بصحة الجسم العامة، حيث يمكن أن تؤثر أمراض اللثة على القلب والسكري.",
        "image_prompt": "dental health concept, clean white teeth and healthy gums, bright lighting, medical dental, no humans no faces no people"
    },
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}


def fetch_feed(url, timeout=10):
    """Fetch and parse an RSS feed, return list of (title, description) tuples."""
    items = []
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        root = ET.fromstring(data)
        # Handle RSS 2.0
        channel = root.find("channel")
        if channel is not None:
            for item in channel.findall("item")[:15]:
                title = item.findtext("title", "").strip()
                desc = item.findtext("description", "").strip()
                desc = re.sub(r"<[^>]+>", "", desc).strip()
                if title and len(title) > 10:
                    items.append({"title": title, "description": desc[:200]})
        else:
            # Atom feed
            ns = {"atom": "http://www.w3.org/2005/Atom"}
            for entry in root.findall("atom:entry", ns)[:15]:
                title = entry.findtext("atom:title", "", ns).strip()
                summary = entry.findtext("atom:summary", "", ns).strip()
                summary = re.sub(r"<[^>]+>", "", summary).strip()
                if title and len(title) > 10:
                    items.append({"title": title, "description": summary[:200]})
    except Exception as e:
        print(f"  ⚠️ Feed failed: {url[:60]}... → {e}")
    return items


def is_health_related(title, description=""):
    """Check if a news item is health-related."""
    text = (title + " " + description).lower()
    return any(kw.lower() in text for kw in HEALTH_KEYWORDS)


def clean_text(text):
    """Clean Arabic text for narration."""
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"&[a-z]+;", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def generate_narration(title, description):
    """Generate a short Arabic narration from title + description."""
    title = clean_text(title)
    desc = clean_text(description) if description else ""
    narration = title + "."
    if desc and desc != title and len(desc) > 20:
        first_sentence = desc.split(".")[0].split("،")[0].strip()
        if len(first_sentence) > 15 and first_sentence != title:
            narration += " " + first_sentence + "."
    return narration


def generate_image_prompt(title):
    """Generate an English image prompt from Arabic health title."""
    health_visuals = {
        "قلب": "human heart anatomy with glowing medical overlay, red and blue lighting, digital health concept",
        "دماغ": "human brain with neural connections glowing, blue and purple light, medical science",
        "سرطان": "medical research laboratory, DNA helix glowing, blue green light, hope and healing",
        "لقاح": "medical syringe with glowing liquid, clean white background, healthcare concept",
        "فيروس": "microscopic virus visualization, red and orange particles, medical science",
        "سكري": "glucose meter with digital display, clean medical aesthetic, blue lighting",
        "ضغط": "blood pressure monitor with digital readout, clean healthcare setting",
        "عيون": "human eye close-up with medical scan overlay, blue light, ophthalmology",
        "أسنان": "dental health concept, clean white teeth, bright lighting, medical",
        "عظام": "skeleton X-ray with blue glow, medical imaging, orthopedic",
        "تغذية": "healthy food arrangement, fresh fruits and vegetables, vibrant colors, nutrition",
        "رياضة": "fitness and wellness concept, running shoes and water bottle, energetic, health",
        "نوم": "peaceful sleep concept, moon and stars, calming blue tones, rest",
        "صحة": "general health and wellness, medical cross symbol, green and white, healing",
        "دواء": "pharmaceutical pills and capsules, clean medical background, blue white",
        "مستشفى": "modern hospital interior, clean and bright, healthcare facility",
        "طبيب": "stethoscope on clean surface, medical professional tool, blue white",
        "علاج": "healing and recovery concept, warm light, medical care, hope",
        "مرض": "medical awareness concept, ribbon symbol, soft lighting, health",
        "وقاية": "prevention and protection concept, shield with medical cross, green blue",
        "تدخين": "anti-smoking concept, healthy lungs, red warning, medical awareness",
        "نفسي": "mental health concept, brain with warm light, purple and gold, wellness",
        "مناعة": "immune system concept, shield with cells, blue and green, protection",
        "حمية": "healthy diet concept, fresh salad and vegetables, green and fresh, nutrition",
        "ألياف": "high fiber foods, oats and grains, digestive health, warm earthy tones",
        "فم": "dental health, clean white teeth, bright lighting, oral care",
        "بشرة": "healthy skin concept, glowing and radiant, warm natural light, dermatology",
        "شعر": "healthy hair concept, shining and strong, warm brown and gold, hair care",
        "وزن": "healthy weight concept, balanced nutrition, green and blue, wellness",
        "ماء": "clean water and hydration, refreshing blue drops, health and wellness",
        "شمس": "sunlight and vitamin D, golden rays, health and energy, outdoor wellness",
        "فيتامين": "vitamins and supplements, colorful pills, health and nutrition, bright",
    }
    title_lower = title.lower()
    for keyword, prompt in health_visuals.items():
        if keyword in title_lower:
            return prompt + ", no humans no faces no people, cinematic, 8k"
    return "modern healthcare concept, medical technology, blue and white lighting, clean design, no humans no faces no people, cinematic"


def mood_from_title(title):
    """Pick a mood based on title keywords."""
    t = title.lower()
    if any(w in t for w in ["اكتشاف", "جديد", "أمل", "علاج", "شفاء", "نجاح", "فوز", "فوائد", "تحسين"]):
        return "excited"
    elif any(w in t for w in ["خطر", "تحذير", "وفاة", "مرض", "وباء", "سرطان", "قلق", "تأثير سلبي"]):
        return "serious"
    return "calm"


def main():
    print("=" * 55)
    print("🏥 Arabic Health News → Video Script Generator")
    print("=" * 55)

    all_news = []
    for feed_url, feed_name in RSS_FEEDS:
        print(f"📡 Fetching: {feed_name}...")
        items = fetch_feed(feed_url)
        if items:
            print(f"  ✅ {len(items)} items")
            for item in items:
                item["source"] = feed_name
            all_news.extend(items)
        else:
            print(f"  — no items")

    # Filter for health-related news
    health_news = [item for item in all_news if is_health_related(item["title"], item.get("description", ""))]

    print(f"\n📰 Total news: {len(all_news)}")
    print(f"🏥 Health-related: {len(health_news)}")

    # Deduplicate by title
    seen = set()
    unique_health = []
    for item in health_news:
        t = item["title"]
        if t not in seen and len(t) > 10:
            seen.add(t)
            unique_health.append(item)

    # If not enough health news, supplement with curated fallback topics
    if len(unique_health) < 3:
        print(f"⚠️ Only {len(unique_health)} health items from RSS, adding curated topics...")
        random.shuffle(FALLBACK_HEALTH_TOPICS)
        needed = 8 - len(unique_health)
        for fb in FALLBACK_HEALTH_TOPICS[:needed]:
            if fb["title"] not in seen:
                unique_health.append({
                    "title": fb["title"],
                    "description": fb["description"],
                    "source": "Curated",
                    "_image_prompt": fb["image_prompt"]
                })

    # Pick top 6 news items
    selected = unique_health[:6]
    print(f"   Selected: {len(selected)} topics")
    for s in selected:
        print(f"   - {s['title'][:60]}")

    # Build scenes
    scenes = []

    # Scene 1: Intro
    scenes.append({
        "scene_number": 1,
        "narration_text": "مرحبا بكم في نشرة أخبار الصحة. نستعرض معكم آخر الأخبار والمعلومات الطبية والصحية المهمة لصحتكم ورفاهيتكم.",
        "caption_text": "نشرة أخبار الصحة",
        "mood": "calm",
        "image_prompt": "modern health news studio, medical cross symbol, blue and white, professional broadcast, no humans no faces no people, cinematic",
        "duration_seconds": 10
    })

    for i, news in enumerate(selected, start=2):
        title = clean_text(news["title"])
        desc = clean_text(news.get("description", ""))
        narration = generate_narration(title, desc)
        mood = mood_from_title(title)
        prompt = news.get("_image_prompt") or generate_image_prompt(title)

        words = title.split()
        caption = " ".join(words[:4])

        scenes.append({
            "scene_number": i,
            "narration_text": narration,
            "caption_text": caption,
            "mood": mood,
            "image_prompt": prompt,
            "duration_seconds": 12
        })

    # Last scene: Outro
    scenes.append({
        "scene_number": len(scenes) + 1,
        "narration_text": "هذه كانت أبرز أخبار الصحة اليوم. تذكروا دائما: الوقاية خير من العلاج. تابعونا للمزيد من الأخبار الصحية. شكرا لمتابعتكم وحفظكم الله.",
        "caption_text": "شكرا لمتابعتكم",
        "mood": "calm",
        "image_prompt": "peaceful health and wellness sunset, medical cross fading, warm golden light, no humans no faces no people, cinematic",
        "duration_seconds": 10
    })

    # Build script
    first_title = clean_text(selected[0]["title"]) if selected else "نشرة أخبار الصحة"
    script = {
        "title": "أخبار الصحة: " + first_title[:50],
        "topic": "صحة وطب",
        "fps": 30,
        "width": 1080,
        "height": 1920,
        "lang": "ar",
        "dir": "rtl",
        "hashtags": "#صحة #طب #أخبار_الصحة #Mawtini #موطني #نصائح_صحية #علاج #وقاية",
        "scenes": scenes
    }

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(SCRIPT_FILE, "w", encoding="utf-8") as f:
        json.dump(script, f, ensure_ascii=False, indent=2)

    print(f"\n✅ Script saved: {SCRIPT_FILE}")
    print(f"   Title: {script['title']}")
    print(f"   Scenes: {len(scenes)}")
    for s in scenes:
        print(f"   Scene {s['scene_number']}: {s['caption_text'][:40]}")


if __name__ == "__main__":
    main()
