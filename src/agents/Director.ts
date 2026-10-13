/**
 * Director.ts — Director Agent
 * 
 * Fetches latest AI/LLM news from RSS feeds, summarizes research using OpenRouter LLM,
 * and outputs a JSON plan for the video.
 * 
 * Usage: npx tsx src/agents/Director.ts --topic="AI news" --duration=120
 */

import * as fs from "fs";
import * as path from "path";
import Parser from "rss-parser";
import { pipelineOptions } from "../pipeline/options";
import { logger, CONFIG, callOpenRouter, writeJSON, sleep } from "./shared";
import type { NewsItem, DirectorOutput } from "../types";

const rss = new Parser();

// ─── RSS Feed Sources ───────────────────────────────────────────
const RSS_FEEDS = [
  { url: "https://arxiv.org/rss/cs.AI", source: "arXiv AI" },
  { url: "https://arxiv.org/rss/cs.LG", source: "arXiv ML" },
  { url: "https://arxiv.org/rss/cs.CL", source: "arXiv NLP" },
  { url: "https://huggingface.co/blog/feed.xml", source: "HuggingFace" },
];

// Arabic tech news RSS feeds
const RSS_FEEDS_AR = [
  { url: "https://arxiv.org/rss/cs.AI", source: "arXiv AI" },
  { url: "https://arxiv.org/rss/cs.CL", source: "arXiv NLP" },
  { url: "https://huggingface.co/blog/feed.xml", source: "HuggingFace" },
  { url: "https://bullrich.dev/tldr-rss/", source: "TLDR AI" },
];

// Health & nutrition RSS feeds (used for health topics)
const RSS_FEEDS_HEALTH = [
  { url: "https://www.healthline.com/rss/health-news", source: "Healthline" },
  { url: "https://www.medicalnewstoday.com/rss/health-news", source: "MedicalNewsToday" },
  { url: "https://feeds.bbci.co.uk/arabic/topics/health/rss.xml", source: "BBC Arabic Health" },
  { url: "https://www.aljazeera.net/aljazeerarss/a7c186be-1baa-4fa1-b504-0f002e481812/73d0e1b4-532f-45ef-b135-bfdff8b8cab9", source: "Al Jazeera Health" },
];

/**
 * Fetch news from a single RSS feed with error handling
 */
async function fetchRSSFeed(url: string, source: string): Promise<NewsItem[]> {
  try {
    logger.info(`Fetching RSS: ${source} (${url})`);
    const feed = await rss.parseURL(url);
    const items = feed.items.slice(0, 5).map((item) => ({
      title: item.title || "",
      link: item.link || "",
      pubDate: item.pubDate,
      contentSnippet: item.contentSnippet?.substring(0, 200),
      source,
    }));
    logger.success(`Fetched ${items.length} items from ${source}`);
    return items;
  } catch (err: any) {
    logger.warn(`Failed to fetch ${source}: ${err.message}`);
    return [];
  }
}

/**
 * Fetch all news from all RSS feeds in parallel
 */
async function fetchAllNews(): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    RSS_FEEDS.map((feed) => fetchRSSFeed(feed.url, feed.source))
  );

  const allNews: NewsItem[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      allNews.push(...result.value);
    }
  }

  logger.success(`Total news items fetched: ${allNews.length}`);
  return allNews;
}

/**
 * Summarize news using OpenRouter LLM
 */
async function summarizeResearch(topic: string, news: NewsItem[]): Promise<DirectorOutput> {
  const newsText = news
    .slice(0, 15)
    .map((n) => `- ${n.title} (${n.source})${n.contentSnippet ? ": " + n.contentSnippet : ""}`)
    .join("\n");

  const messages = [
    {
      role: "system",
      content: CONFIG.language === "ar"
        ? `أنت مخرج محتوى فيديو متخصص في أخبار الذكاء الاصطناعي والتكنولوجيا. حلل الأخبار الحديثة وأنشئ خطة لفيديو قصير. أجب فقط بـ JSON (بدون markdown، بدون كود) بهذا الهيكل:
{
  "research_summary": "ملخص 2-3 جمل لأبرز مواضيع أخبار الذكاء الاصطناعي",
  "key_headlines": ["عنوان 1", "عنوان 2", "عنوان 3"],
  "suggested_duration": 30,
  "tone": "serious|excited|hopeful|urgent"
}`
        : `You are a video content director specializing in AI/tech news. Analyze recent news and create a plan for a short video. Respond ONLY with a JSON object (no markdown, no code blocks) with this exact structure:
{
  "research_summary": "A 2-3 sentence summary of the key AI news themes",
  "key_headlines": ["headline 1", "headline 2", "headline 3"],
  "suggested_duration": 30,
  "tone": "serious|excited|hopeful|urgent"
}`,
    },
    {
      role: "user",
      content: CONFIG.language === "ar"
        ? `الموضوع: "${topic}"

أبرز عناوين أخبار الذكاء الاصطناعي:
${newsText}

حلل هذه العناوين وأنشئ خطة فيديو جذابة ومفيدة لجمهور عربي مهتم بالتكنولوجيا.`
        : `Topic: "${topic}"

Recent AI News Headlines:
${newsText}

Analyze these headlines and create a video plan. The video should be engaging and informative for a tech-savvy audience.`,
    },
  ];

  logger.agent("Director", "Calling OpenRouter to summarize research...");
  const response = await callOpenRouter(messages, { temperature: 0.5, maxTokens: 1024 });

  try {
    const parsed = JSON.parse(response);
    return parsed as DirectorOutput;
  } catch {
    // If JSON parsing fails, create a fallback
    logger.warn("Failed to parse OpenRouter response, using fallback");
    return {
      research_summary: `Latest AI developments covering ${news.length} news items from major sources.`,
      key_headlines: news.slice(0, 3).map((n) => n.title),
      suggested_duration: 120,
      tone: "neutral",
    };
  }
}

/**
 * Main Director function
 */
export async function runDirector(topic: string, duration: number): Promise<DirectorOutput> {
  logger.agent("Director", "🎬 Starting Director Agent...");
  logger.info(`Topic: "${topic}"`);
  logger.info(`Language: ${CONFIG.language}, Duration: ${CONFIG.duration}s`);

  // Fetch news — select feeds based on topic category
  const healthKeywords = ["food", "nutrition", "health", "diet", "vitamin", "mineral", "magnesium", "protein", "foods", "eat", "healthy", "تغذية", "صحة", "طعام", "فيتامينات", "معادن", "مغنيسيوم", "بروتين", "حمية"];
  const isHealthTopic = healthKeywords.some(kw => topic.toLowerCase().includes(kw));
  let feeds;
  if (isHealthTopic) {
    feeds = RSS_FEEDS_HEALTH;
  } else {
    feeds = CONFIG.language === "ar" ? RSS_FEEDS_AR : RSS_FEEDS;
  }
  const results = await Promise.allSettled(
    feeds.map((feed) => fetchRSSFeed(feed.url, feed.source))
  );

  const allNews: NewsItem[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      allNews.push(...result.value);
    }
  }

  if (allNews.length === 0) {
    logger.warn("No news fetched from RSS feeds, using topic only");
  }

  // Summarize
  const output = await summarizeResearch(topic, allNews);
  output.suggested_duration = duration || CONFIG.duration || output.suggested_duration;

  logger.success(`Research Summary: ${output.research_summary}`);
  logger.success(`Key Headlines: ${output.key_headlines.join(", ")}`);
  logger.success(`Tone: ${output.tone}`);

  // Save director output for ScriptWriter
  const directorPath = path.join(CONFIG.dataDir, "director_output.json");
  writeJSON(directorPath, output);

  return output;
}

// ─── CLI Entry Point ────────────────────────────────────────────
if (require.main === module) {
  const { topic, duration } = pipelineOptions(process.argv.slice(2), CONFIG.duration);

  runDirector(topic, duration)
    .then(() => {
      logger.success("Director Agent completed!");
      process.exit(0);
    })
    .catch((err) => {
      logger.error(`Director Agent failed: ${err.message}`);
      process.exit(1);
    });
}
