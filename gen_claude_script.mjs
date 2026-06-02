// gen_claude_script.mjs — Generate script about Claude Code agent news
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

const PROJECT = "/root/ianews";
const DATA = join(PROJECT, "data");
const IMAGES = join(PROJECT, "public/images");
const AUDIO = join(PROJECT, "public/audio");

// Load .env
const env = {};
const envFile = join(PROJECT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    if (line.includes("=") && !line.startsWith("#")) {
      const [k, ...v] = line.split("=");
      env[k.trim()] = v.join("=").trim();
    }
  }
}

const OPENROUTER_KEY = env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = env.OPENROUTER_MODEL || "openai/gpt-oss-120b:free";

async function fetchText(url) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, { headers: { "User-Agent": "iAnews/1.0" }, signal: ctrl.signal });
    return await res.text();
  } catch { return ""; }
}

function extractRSS(text, maxItems = 5) {
  const titles = [...text.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/g)].map(m => m[1].replace(/<[^>]+>/g, "").trim());
  const descs = [...text.matchAll(/<description[^>]*>([\s\S]*?)<\/description>/g)].map(m => m[1].replace(/<[^>]+>/g, "").trim().slice(0, 300));
  const items = [];
  for (let i = 1; i < titles.length && items.length < maxItems; i++) {
    if (titles[i].length > 10) {
      items.push({ title: titles[i].slice(0, 150), description: (descs[i] || "").slice(0, 200) });
    }
  }
  return items;
}

async function fetchHackerNews() {
  try {
    const data = await fetchText("https://hacker-news.firebaseio.com/v0/topstories.json");
    const ids = JSON.parse(data).slice(0, 30);
    const items = [];
    for (const id of ids) {
      try {
        const item = JSON.parse(await fetchText(`https://hacker-news.firebaseio.com/v0/item/${id}.json`));
        const title = item.title || "";
        if (/claude|anthropic|ai agent|coding agent|claude code|copilot|devin/i.test(title) && items.length < 5) {
          items.push({ title, description: (item.text || "").replace(/<[^>]+>/g, "").slice(0, 300) });
        }
      } catch {}
    }
    return items;
  } catch { return []; }
}

console.log("Fetching latest Claude Code / AI agent news...\n");

const [hnItems, tcFeed, arsFeed] = await Promise.all([
  fetchHackerNews(),
  fetchText("https://techcrunch.com/feed/"),
  fetchText("https://feeds.arstechnica.com/arstechnica/index"),
]);

const allItems = [...hnItems];
for (const item of [...extractRSS(tcFeed), ...extractRSS(arsFeed)]) {
  if (/claude|anthropic|ai agent|coding agent|claude code|copilot|devin/i.test(item.title + item.description)) {
    if (!allItems.find(a => a.title === item.title)) allItems.push(item);
  }
}
if (allItems.length < 3) {
  for (const item of [...extractRSS(tcFeed), ...extractRSS(arsFeed)].slice(0, 4)) {
    if (!allItems.find(a => a.title === item.title)) allItems.push(item);
  }
}

console.log(`Found ${allItems.length} articles:`);
allItems.forEach((a, i) => console.log(`  ${i+1}. ${a.title.slice(0, 80)}`));

const articlesText = allItems.slice(0, 5).map((a, i) => `${i+1}. ${a.title}: ${a.description}`).join("\n");

const prompt = `You are an Arabic tech news video script writer. Create a 30-second video about the LATEST Claude Code / AI coding agent news.

Articles:
${articlesText}

Return ONLY valid JSON (no markdown):
{
  "topic": "Arabic title about Claude Code news",
  "total_duration": 30,
  "research_summary": "2-sentence Arabic summary",
  "scenes": [
    {
      "scene_number": 1,
      "narration_text": "Arabic narration (2-3 sentences, conversational, mention Claude Code & Anthropic)",
      "visual_prompt": "English cinematic visual description, tech/news style",
      "duration_seconds": 8,
      "mood": "excited",
      "voice_emotion": "cheerful"
    }
  ]
}

Rules: Exactly 4 scenes (8+8+7+7 seconds). Arabic Modern Standard Arabic narration. Mention Claude Code/Anthropic specifically. Visual prompts cinematic/tech. Return ONLY JSON.`;

let script;
if (OPENROUTER_KEY && OPENROUTER_KEY.includes("sk-or")) {
  console.log("\nGenerating script via OpenRouter...");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_KEY}`,
      "HTTP-Referer": "https://ianews.app",
      "X-Title": "iAnews"
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2048,
      temperature: 0.8
    })
  });
  const data = await res.json();
  const content = data.choices[0].message.content;
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  script = JSON.parse(jsonMatch[0]);
} else {
  script = {
    topic: "Claude Code: أخبار جديدة عن وكيل الذكاء الاصطناعي للبرمجة",
    total_duration: 30,
    research_summary: "أنثروبيك تحدث Claude Code بميزات جديدة للوكلاء الذكيين",
    scenes: [
      { scene_number: 1, narration_text: "مرحباً بكم! اليوم نتحدث عن آخر أخبار Claude Code، وكيل الذكاء الاصطناعي للبرمجة من شركة أنثروبيك.", visual_prompt: "Futuristic AI coding assistant, glowing terminal with code, Claude logo, blue cinematic lighting", duration_seconds: 8, mood: "excited", voice_emotion: "cheerful" },
      { scene_number: 2, narration_text: "Claude Code أصبح قادراً على إنجاز مهام برمجية معقدة بشكل مستقل. يمكنه كتابة الكود وتصحيح الأخطاء.", visual_prompt: "Robot programmer writing code on holographic screen, complex algorithms floating, matrix data flow", duration_seconds: 8, mood: "hopeful", voice_emotion: "excited" },
      { scene_number: 3, narration_text: "المنافسة تشتد بين شركات الذكاء الاصطناعي. GitHub Copilot وDevin وClaude Code يتسابقون.", visual_prompt: "Multiple AI agents racing, competition leaderboard, tech companies logos, dynamic visualization", duration_seconds: 7, mood: "urgent", voice_emotion: "serious" },
      { scene_number: 4, narration_text: "تابعونا للمزيد من أخبار الذكاء الاصطناعي والتقنية. لا تنسوا الاشتراك!", visual_prompt: "Call to action subscribe button, social media icons, digital celebration confetti", duration_seconds: 7, mood: "excited", voice_emotion: "cheerful" }
    ]
  };
}

// Set paths
for (const scene of script.scenes) {
  scene.image_path = join(IMAGES, `scene_${scene.scene_number}.jpg`);
  scene.audio_path = join(AUDIO, `scene_${scene.scene_number}.mp3`);
  scene.audio_duration = scene.duration_seconds;
}
script.generated_at = new Date().toISOString();

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, "script.json"), JSON.stringify(script, null, 2), "utf-8");
console.log(`\nScript saved! Topic: ${script.topic}`);
