import {z} from "zod";

// ─── Scene Schema ───────────────────────────────────────────────
export const SceneSchema = z.object({
  scene_number: z.number().int().positive(),
  narration_text: z.string().min(10),
  caption_text: z.string().optional(),
  visual_prompt: z.string().min(10),
  duration_seconds: z.number().min(3).max(60),
  mood: z.enum(["neutral", "excited", "serious", "hopeful", "urgent", "calm"]),
  voice_emotion: z.enum(["friendly", "cheerful", "sad", "angry", "excited", "terrified", "shouting", "unfriendly", "whispering", "hopeful"]),
  image_path: z.string().optional(),
  audio_path: z.string().optional(),
  audio_duration: z.number().finite().positive().optional(),
});

export type Scene = z.infer<typeof SceneSchema>;

// ─── Script Schema ──────────────────────────────────────────────
export const ScriptSchema = z.object({
  topic: z.string(),
  total_duration: z.number(),
  generated_at: z.string(),
  research_summary: z.string(),
  scenes: z.array(SceneSchema).min(1),
});

export type Script = z.infer<typeof ScriptSchema>;

// ─── Director Output ────────────────────────────────────────────
export type NewsItem = {
  title: string;
  link: string;
  pubDate?: string;
  contentSnippet?: string;
  source: string;
};

export type DirectorOutput = {
  research_summary: string;
  key_headlines: string[];
  suggested_duration: number;
  tone: string;
};

// ─── Voice Mapping ──────────────────────────────────────────────
export type Mood = Scene["mood"];
export type VoiceEmotion = Scene["voice_emotion"];

// Map mood to edge-tts voice name (only voices that work reliably)
export const MOOD_VOICE_MAP: Record<Mood, string> = {
  neutral: "en-US-JennyNeural",
  excited: "en-US-GuyNeural",
  serious: "en-US-GuyNeural",
  hopeful: "en-US-AriaNeural",
  urgent: "en-US-GuyNeural",
  calm: "en-US-JennyNeural",
};

// Arabic voice map — primary Arabic TTS voices
export const MOOD_VOICE_MAP_AR: Record<Mood, string> = {
  neutral: "ar-SA-ZariyahNeural",
  excited: "ar-AE-FatimaNeural",
  serious: "ar-SA-HamedNeural",
  hopeful: "ar-AE-FatimaNeural",
  urgent: "ar-SA-HamedNeural",
  calm: "ar-SA-ZariyahNeural",
};

// Map voice emotion to edge-tts style
export const EMOTION_STYLE_MAP: Record<VoiceEmotion, string> = {
  friendly: "friendly",
  cheerful: "cheerful",
  sad: "sad",
  angry: "angry",
  excited: "excited",
  terrified: "terrified",
  shouting: "shouting",
  unfriendly: "unfriendly",
  whispering: "whispering",
  hopeful: "hopeful",
};

// ─── Remotion Types ─────────────────────────────────────────────
export type SceneAsset = Scene & {
  image_path: string;
  audio_path: string;
  audio_duration: number;
};

export type VideoCompositionProps = {
  scenes: SceneAsset[];
  topic: string;
  fps: number;
};
