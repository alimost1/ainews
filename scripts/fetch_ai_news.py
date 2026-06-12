#!/usr/bin/env python3
"""Fetch today's AI news from multiple RSS feeds and generate a script.json for iAnews."""

import json
import os
import re
import subprocess
import sys
from datetime import datetime

PROJECT = "/root/ianews"
DATA_DIR = os.path.join(PROJECT, "data")

# ─── RSS Feed Sources ───────────────────────────────────────────────
RSS_FEEDS = {
    "madebyagents_ai_agents": "https://www.madebyagents.com/rss/ai-agents",
    "madebyagents_ai": "https://www.madebyagents.com/rss/artificial-intelligence",
    "7min_digest": "https://7min.ai/daily-ai-news-llms.txt",
}

# Fallback: France24 Arabic for general news
FALLBACK_FEEDS = [
    "https://www.france24.com/ar/rss",
]


def fetch_url(url, timeout=15):
    """Fetch URL content via curl."""
    try:
        result = subprocess.run(
            ["curl", "-s", "--max-time", str(timeout), url],
            capture_output=True, timeout=timeout + 5
        )
        if result.returncode == 0:
            return result.stdout.decode("utf-8", errors="replace")
    except Exception:
        pass
    return ""


def parse_rss_titles(xml_data, max_items=10):
    """Extract titles and descriptions from RSS XML."""
    items = []
    # Split into <item> blocks
    blocks = re.findall(r'<item>(.*?)</item>', xml_data, re.DOTALL)
    for block in blocks[:max_items]:
        title = re.search(r'<title[^>]*>(.*?)</title>', block, re.DOTALL)
        desc = re.search(r'<description[^>]*>(.*?)</description>', block, re.DOTALL)
        date = re.search(r'<pubDate[^>]*>(.*?)</pubDate>', block, re.DOTALL)
        link = re.search(r'<link[^>]*>(.*?)</link>', block, re.DOTALL)

        t = re.sub(r'<[^>]+>', '', title.group(1)).strip() if title else ""
        d = re.sub(r'<[^>]+>', '', desc.group(1)).strip() if desc else ""
        dt = re.sub(r'<[^>]+>', '', date.group(1)).strip() if date else ""
        lk = re.sub(r'<[^>]+>', '', link.group(1)).strip() if link else ""

        # Clean up CDATA
        t = re.sub(r'<!\[CDATA\[|\]\]>', '', t).strip()
        d = re.sub(r'<!\[CDATA\[|\]\]>', '', d).strip()

        if t and len(t) > 5:
            items.append({"title": t, "description": d[:200], "date": dt, "link": lk})
    return items


def parse_7min_digest(text):
    """Parse 7min.ai llms.txt format."""
    items = []
    # Extract date
    date_match = re.search(r'Date:\s*(\d{4}-\d{2}-\d{2})', text)
    date_str = date_match.group(1) if date_match else datetime.now().strftime("%Y-%m-%d")

    # Extract news items: lines starting with "## " are headlines
    # Pattern: ## Title\n\nDescription text\n\nNews · score · Source
    sections = re.split(r'\n## ', text)
    for section in sections[1:]:  # Skip header
        lines = section.strip().split('\n')
        if not lines:
            continue
        title = lines[0].strip()
        # Get description (next non-empty line)
        desc = ""
        source = ""
        for line in lines[1:]:
            line = line.strip()
            if line.startswith("News ·"):
                parts = line.split("·")
                if len(parts) >= 3:
                    source = parts[-1].strip()
                break
            elif line and not line.startswith("-") and not line.startswith("["):
                desc = line[:200]
        if title and len(title) > 5:
            items.append({"title": title, "description": desc, "date": date_str, "source": source})
    return items


def fetch_all_news():
    """Fetch news from all sources and merge."""
    all_items = []

    print("📡 Fetching AI news from RSS feeds...\n")

    # 1. Made By Agents — AI Agents
    print("  → Made By Agents (AI Agents)...")
    xml = fetch_url(RSS_FEEDS["madebyagents_ai_agents"])
    items = parse_rss_titles(xml, max_items=5)
    for item in items:
        item["source"] = "Made By Agents"
    all_items.extend(items)
    print(f"    Found {len(items)} items")

    # 2. Made By Agents — Artificial Intelligence
    print("  → Made By Agents (AI)...")
    xml = fetch_url(RSS_FEEDS["madebyagents_ai"])
    items = parse_rss_titles(xml, max_items=5)
    for item in items:
        item["source"] = "Made By Agents"
    all_items.extend(items)
    print(f"    Found {len(items)} items")

    # 3. 7min.ai daily digest
    print("  → 7min.ai daily digest...")
    text = fetch_url(RSS_FEEDS["7min_digest"])
    items = parse_7min_digest(text)
    for item in items:
        item["source"] = "7min.ai"
    all_items.extend(items)
    print(f"    Found {len(items)} items")

    # 4. Fallback: France24 Arabic
    if len(all_items) < 3:
        print("  → Fallback: France24 Arabic...")
        xml = fetch_url(FALLBACK_FEEDS[0])
        items = parse_rss_titles(xml, max_items=5)
        for item in items:
            item["source"] = "France24"
        all_items.extend(items)
        print(f"    Found {len(items)} items")

    print(f"\n📰 Total news items: {len(all_items)}")
    return all_items


def select_top_news(items, count=5):
    """Select the most relevant/recent news items."""
    # Deduplicate by title similarity
    seen_titles = set()
    unique = []
    for item in items:
        t_lower = item["title"].lower()[:40]
        if t_lower not in seen_titles:
            seen_titles.add(t_lower)
            unique.append(item)
    return unique[:count]


def translate_to_arabic_context(title, description):
    """Generate Arabic context for a news item. Returns (arabic_title, arabic_summary)."""
    # For now, return the original if already in Arabic, or a placeholder
    # The LLM will handle translation during script generation
    return title, description


if __name__ == "__main__":
    news_items = fetch_all_news()
    top_news = select_top_news(news_items, count=7)

    os.makedirs(DATA_DIR, exist_ok=True)
    output_path = os.path.join(DATA_DIR, "ai_news_fetched.json")

    data = {
        "date": datetime.now().strftime("%Y-%m-%d"),
        "source": "RSS aggregation",
        "feeds": list(RSS_FEEDS.keys()),
        "items": top_news,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n✅ Saved {len(top_news)} news items to {output_path}")
    print("\nTop stories:")
    for i, item in enumerate(top_news, 1):
        print(f"  {i}. {item['title'][:70]}")
