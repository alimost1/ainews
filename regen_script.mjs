// regen_script.mjs — Regenerate script with better visual prompts for SDXL
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

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

// New script with HIGH-QUALITY, concrete visual prompts optimized for SDXL
// Each prompt is a single concrete scene description (not abstract concepts)
const script = {
  "topic": "Claude Code: أحدث تحديث لوكيل البرمجة الذكي",
  "total_duration": 30,
  "research_summary": "أنثروبيك تطلق تحديثاً كبيراً لـ Claude Code مع تحسينات في السرعة والدقة والتكامل مع أدوات التطوير",
  "generated_at": new Date().toISOString(),
  "scenes": [
    {
      "scene_number": 1,
      "narration_text": "مرحباً بكم! اليوم نتحدث عن تحديث كبير لـ Claude Code من شركة أنثروبيك. هذا الوكيل الذكي أصبح أسرع وأذكى من أي وقت مضى!",
      "visual_prompt": "A photorealistic photo of a modern laptop screen on a wooden desk, displaying a code editor with colorful Python syntax highlighting, soft natural lighting from a window, a coffee cup beside the laptop, clean minimalist workspace, 8k resolution, professional photography",
      "duration_seconds": 8,
      "mood": "excited",
      "voice_emotion": "cheerful"
    },
    {
      "scene_number": 2,
      "narration_text": "التحديث الجديد يقلل الأخطاء البرمجية بنسبة 30 بالمئة. المطورون الآن يكتبون كوداً أنظف وأسرع بمساعدة الذكاء الاصطناعي.",
      "visual_prompt": "A photorealistic photo of a young developer looking at a large monitor showing green checkmarks and code review results, modern office environment, warm desk lighting, multiple monitors showing code, professional tech workspace photography, 8k",
      "duration_seconds": 8,
      "mood": "hopeful",
      "voice_emotion": "excited"
    },
    {
      "scene_number": 3,
      "narration_text": "Claude Code يعمل الآن مباشرة داخل Visual Studio Code و JetBrains. لا حاجة لتغيير أدواتك المفضلة!",
      "visual_prompt": "A photorealistic computer screen showing the VS Code interface with a purple AI chat panel on the right side, dark theme code editor, a software developer's hands on keyboard, modern office background blurred, professional photography, 8k quality",
      "duration_seconds": 7,
      "mood": "excited",
      "voice_emotion": "cheerful"
    },
    {
      "scene_number": 4,
      "narration_text": "أنثروبيك تواصل الابتكار في عالم البرمجة الذكية. تابعونا للمزيد من أخبار التقنية والذكاء الاصطناعي!",
      "visual_prompt": "A photorealistic futuristic cityscape at night with glowing blue and purple neon lights reflecting on wet streets, technology company buildings with illuminated windows, flying data visualizations in the sky, cinematic atmosphere, ultra wide shot, 8k photography",
      "duration_seconds": 7,
      "mood": "excited",
      "voice_emotion": "cheerful"
    }
  ]
};

// Set paths
for (const scene of script.scenes) {
  scene.image_path = join(IMAGES, `scene_${scene.scene_number}.jpg`);
  scene.audio_path = join(AUDIO, `scene_${scene.scene_number}.mp3`);
  scene.audio_duration = scene.duration_seconds;
}

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, "script.json"), JSON.stringify(script, null, 2), "utf-8");
console.log("Script regenerated with better visual prompts!");
console.log("Topic:", script.topic);
script.scenes.forEach(s => {
  console.log(`\nScene ${s.scene_number}: ${s.visual_prompt.substring(0, 80)}...`);
});
