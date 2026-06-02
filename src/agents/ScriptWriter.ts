/**
 * ScriptWriter.ts — ScriptWriter Agent
 * 
 * Takes the user topic + director research, calls OpenRouter to generate
 * a JSON array of scenes (narration, visual prompt, duration, mood, voice emotion).
 * Saves script to data/script.json.
 * 
 * Usage: npx tsx src/agents/ScriptWriter.ts
 */

import * as path from "path";
import { logger, CONFIG, callOpenRouter, readJSON, writeJSON, extractJSON } from "./shared";
import type { DirectorOutput, Script, Scene } from "../types";

const SCRIPT_PATH = path.join(CONFIG.dataDir, "script.json");
const DIRECTOR_PATH = path.join(CONFIG.dataDir, "director_output.json");

/**
 * Generate video script from research using OpenRouter LLM
 */
async function generateScript(topic: string, research: DirectorOutput): Promise<Script> {
  const isAr = CONFIG.language === "ar";
  const targetDuration = CONFIG.duration || research.suggested_duration || 30;
  const sceneCount = Math.min(Math.max(Math.round(targetDuration / 7), 3), 5);

  const messages = [
    {
      role: "system" as const,
      content: isAr
        ? `أنت كاتب سيناريو فيديو خبير متخصص في محتوى أخبار الذكاء الاصطناعي والتكنولوجيا. أنشئ سيناريوهات فيديو جذابة للمحتوى القصير (ريلز / تيك توك).

أجب فقط بـ JSON (بدون markdown، بدون كود) بهذا الهيكل:
{
  "topic": "موضوع الفيديو",
  "total_duration": ${targetDuration},
  "scenes": [
    {
      "scene_number": 1,
      "narration_text": "النص العربي المقروء لهذه المشهد (30-80 كلمة، لغة عربية فصيحة بسيطة)",
      "caption_text": "عنوان إخباري قصير يظهر على الشاشة (2-8 كلمات، بدون علامات ترقيم، بأسلوب العناوين الإخبارية، مثال: ثورة الذكاء الاصطناعي أو ملايين الرموز في ثانية)",
      "visual_prompt": "وصف بصري تفصيلي لتوليد الصورة (بالإنجليزية، وصفي)",
      "duration_seconds": 7,
      "mood": "neutral|excited|serious|hopeful|urgent|calm",
      "voice_emotion": "friendly|cheerful|sad|angry|excited|terrified|shouting|unfriendly|whispering|hopeful"
    }
  ]
}

القواعد:
- أنشئ ${sceneCount} مشاهد
- كل مشهد ${Math.round(targetDuration / sceneCount)}-12 ثانية
- المدة الإجمالية يجب أن تطابق ${targetDuration} ثانية
- السرد يجب أن يكون حواريًا وجذابًا بالعربية الفصحى البسيطة
- أوصاف الصور بالإنجليزية وتفصيلية
- نوّع المزاج والعاطفة بين المشاهد
- المشهد الأول يجب أن يجذب المشاهد
- المشهد الأخير يجب أن يتضمن دعوة للمتابعة
- نص التعليق (caption_text) يجب أن يكون بأسلوب العناوين الإخبارية القصيرة والجذابة`
        : `You are an expert video scriptwriter specializing in AI/tech news content. Create engaging, informative video scripts for short-form content (TikTok/YouTube Shorts style).

Respond ONLY with a JSON object (no markdown, no code blocks) with this exact structure:
{
  "topic": "the video topic",
  "total_duration": ${targetDuration},
  "scenes": [
    {
      "scene_number": 1,
      "narration_text": "The exact text to be spoken in this scene (30-80 words)",
      "caption_text": "Short news headline style caption (2-8 words, no punctuation, punchy news ticker style, e.g. 'AI Revolution' or 'Million Tokens Per Second')",
      "visual_prompt": "Detailed visual description for image generation (English, descriptive)",
      "duration_seconds": 7,
      "mood": "neutral|excited|serious|hopeful|urgent|calm",
      "voice_emotion": "friendly|cheerful|sad|angry|excited|terrified|shouting|unfriendly|whispering|hopeful"
    }
  ]
}

Rules:
- Create ${sceneCount} scenes
- Each scene ${Math.round(targetDuration / sceneCount)}-12 seconds
- Total duration should match ${targetDuration} seconds
- Narration should be conversational and engaging
- Visual prompts should be descriptive and specific in English
- Vary the mood and voice emotion across scenes
- First scene should hook the viewer
- Last scene should have a call-to-action`,
    },
    {
      role: "user" as const,
      content: isAr
        ? `أنشئ سيناريو فيديو عن: "${topic}"

ملخص البحث: ${research.research_summary}

أبرز العناوين:
${research.key_headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}

النبرة: ${research.tone}
المدة المستهدفة: ${targetDuration} ثانية`
        : `Create a video script about: "${topic}"

Research Summary: ${research.research_summary}

Key Headlines:
${research.key_headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Tone: ${research.tone}
Target Duration: ${targetDuration} seconds`,
    },
  ];

  logger.agent("ScriptWriter", "Calling OpenRouter to generate script...");
  const response = await callOpenRouter(messages, { temperature: 0.8, maxTokens: 4096 });

  try {
    const parsed = extractJSON(response);
    const script: Script = {
      topic,
      total_duration: parsed.total_duration || research.suggested_duration,
      generated_at: new Date().toISOString(),
      research_summary: research.research_summary,
      scenes: parsed.scenes.map((s: any, i: number) => ({
        scene_number: i + 1,
        narration_text: s.narration_text,
        caption_text: s.caption_text || "",
        visual_prompt: s.visual_prompt,
        duration_seconds: s.duration_seconds,
        mood: s.mood || "neutral",
        voice_emotion: s.voice_emotion || "friendly",
      })),
    };

    logger.success(`Generated ${script.scenes.length} scenes (${script.total_duration}s total)`);
    return script;
  } catch (err: any) {
    logger.warn(`Failed to parse script: ${err.message}, creating fallback`);
    return createFallbackScript(topic, research);
  }
}

/**
 * Create a minimal fallback script if LLM fails
 */
function createFallbackScript(topic: string, research: DirectorOutput): Script {
  const scenes: Scene[] = research.key_headlines.slice(0, 5).map((headline, i) => ({
    scene_number: i + 1,
    narration_text: i === 0
      ? `Welcome to iAnews! Today we're covering: ${topic}. ${headline}. Let's dive in!`
      : headline,
    caption_text: headline.substring(0, 50),
    visual_prompt: `Professional technology news broadcast, futuristic AI laboratory, glowing data visualizations, ${headline}, cinematic lighting, 4K`,
    duration_seconds: 15,
    mood: (["hopeful", "excited", "serious", "neutral", "calm"] as const)[i % 5],
    voice_emotion: (["friendly", "cheerful", "excited", "hopeful", "friendly"] as const)[i % 5],
  }));

  return {
    topic,
    total_duration: scenes.reduce((sum, s) => sum + s.duration_seconds, 0),
    generated_at: new Date().toISOString(),
    research_summary: research.research_summary,
    scenes,
  };
}

/**
 * Main ScriptWriter function
 */
export async function runScriptWriter(topic?: string): Promise<Script> {
  logger.agent("ScriptWriter", "✍️ Starting ScriptWriter Agent...");
  logger.info(`Language: ${CONFIG.language}, Duration: ${CONFIG.duration}s`);

  // Load director output
  let research: DirectorOutput;
  try {
    research = readJSON<DirectorOutput>(DIRECTOR_PATH);
    logger.info(`Loaded director output from ${DIRECTOR_PATH}`);
  } catch {
    logger.warn("No director output found, using defaults");
    research = {
      research_summary: "Latest AI developments and breakthroughs.",
      key_headlines: ["AI continues to advance rapidly", "New models released", "Industry adoption grows"],
      suggested_duration: 120,
      tone: "neutral",
    };
  }

  const script = await generateScript(topic || research.key_headlines[0] || "AI News", research);

  // Save script
  writeJSON(SCRIPT_PATH, script);
  logger.success(`Script saved to ${SCRIPT_PATH}`);

  return script;
}

// ─── CLI Entry Point ────────────────────────────────────────────
if (require.main === module) {
  const topic = process.argv.find((a, i) => a === "--topic" && process.argv[i + 1])
    ? process.argv[process.argv.indexOf("--topic") + 1]
    : undefined;

  runScriptWriter(topic)
    .then(() => {
      logger.success("ScriptWriter Agent completed!");
      process.exit(0);
    })
    .catch((err) => {
      logger.error(`ScriptWriter Agent failed: ${err.message}`);
      process.exit(1);
    });
}
