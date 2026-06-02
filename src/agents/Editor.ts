/**
 * Editor.ts — Editor Agent
 * 
 * Generates the Remotion VideoComposition.tsx component that syncs
 * all images and audio assets into a complete video.
 * 
 * Usage: npx tsx src/agents/Editor.ts
 */

import * as fs from "fs";
import * as path from "path";
import { logger, CONFIG, readJSON, writeJSON } from "./shared";
import type { Script, SceneAsset } from "../types";

const COMPOSITION_PATH = path.join(__dirname, "../components/VideoComposition.tsx");
const SCENE_PATH = path.join(__dirname, "../components/Scene.tsx");
const INDEX_PATH = path.join(__dirname, "../index.ts");
const REMOTION_CONFIG_PATH = path.join(CONFIG.projectRoot, "remotion.config.ts");

/**
 * Generate the Scene component
 */
function generateSceneComponent(): string {
  return `/**
 * Scene.tsx — Individual scene component
 * Renders a single scene with image background, narration text, and audio.
 * Optimized for vertical/reel format (9:16).
 */

import React from "react";
import {
  Img,
  Audio,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  staticFile,
} from "remotion";

export type SceneProps = {
  imagePath: string;
  audioPath: string;
  narrationText: string;
  durationInFrames: number;
  sceneNumber: number;
  mood: string;
};

export const Scene: React.FC<SceneProps> = ({
  imagePath,
  audioPath,
  narrationText,
  durationInFrames,
  sceneNumber,
  mood,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  // Fade in/out
  const opacity = interpolate(
    frame,
    [0, 15, durationInFrames - 15, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateClamp: true }
  );

  // Subtle zoom effect (Ken Burns)
  const scale = interpolate(
    frame,
    [0, durationInFrames],
    [1, 1.08],
    { extrapolateClamp: true }
  );

  // Text slide-up animation
  const textY = interpolate(
    frame,
    [5, 25],
    [30, 0],
    { extrapolateClamp: true }
  );

  // Mood-based overlay gradient
  const overlayGradients: Record<string, string> = {
    neutral: "linear-gradient(to top, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.2) 50%, transparent 100%)",
    excited: "linear-gradient(to top, rgba(20,40,120,0.85) 0%, rgba(20,40,120,0.3) 50%, transparent 100%)",
    serious: "linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.4) 50%, transparent 100%)",
    hopeful: "linear-gradient(to top, rgba(10,60,40,0.85) 0%, rgba(10,60,40,0.3) 50%, transparent 100%)",
    urgent: "linear-gradient(to top, rgba(100,10,10,0.85) 0%, rgba(100,10,10,0.3) 50%, transparent 100%)",
    calm: "linear-gradient(to top, rgba(10,30,60,0.8) 0%, rgba(10,30,60,0.2) 50%, transparent 100%)",
  };

  // Detect if text is RTL (Arabic, Hebrew, etc.)
  const isRTL = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(narrationText);
  const fontFamily = isRTL ? "'Noto Sans Arabic', 'Segoe UI', 'Tahoma', sans-serif" : "'Noto Sans', 'Open Sans', sans-serif";

  // Responsive font size based on video width
  const fontSize = Math.round(width * 0.042); // ~45px at 1080w
  const textPadding = Math.round(width * 0.04);
  const bottomOffset = Math.round(height * 0.12);

  return (
    <Sequence from={0} durationInFrames={durationInFrames}>
      {/* Background Image with Ken Burns zoom */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity,
          transform: \`scale(\${scale})\`,
        }}
      >
        <Img
          src={staticFile(imagePath)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center",
          }}
        />
      </div>

      {/* Gradient overlay for text readability */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: overlayGradients[mood] || overlayGradients.neutral,
        }}
      />

      {/* Narration text — bottom aligned for reel format */}
      <div
        style={{
          position: "absolute",
          bottom: bottomOffset,
          left: textPadding,
          right: textPadding,
          transform: \`translateY(\${textY}px)\`,
          opacity,
        }}
      >
        <div
          style={{
            backgroundColor: "rgba(0,0,0,0.65)",
            borderRadius: 16,
            padding: \`\${textPadding}px \${Math.round(textPadding * 1.2)}px\`,
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          <p
            style={{
              color: "white",
              fontSize,
              fontWeight: 600,
              lineHeight: 1.5,
              margin: 0,
              fontFamily,
              direction: isRTL ? "rtl" : "ltr",
              textAlign: isRTL ? "right" : "left",
              textShadow: "0 2px 12px rgba(0,0,0,0.6)",
            }}
          >
            {narrationText}
          </p>
        </div>
      </div>

      {/* Scene number badge — top right */}
      <div
        style={{
          position: "absolute",
          top: Math.round(height * 0.04),
          right: textPadding,
          backgroundColor: "rgba(31,74,191,0.85)",
          borderRadius: 24,
          padding: "8px 18px",
          color: "white",
          fontSize: Math.round(fontSize * 0.7),
          fontWeight: 700,
          opacity: opacity * 0.9,
          letterSpacing: 1,
        }}
      >
        {sceneNumber}
      </div>

      {/* Audio */}
      <Audio src={staticFile(audioPath)} />
    </Sequence>
  );
};
`;
}

/**
 * Generate the main VideoComposition component
 */
function generateVideoComposition(script: Script): string {
  const scenes = script.scenes as SceneAsset[];
  const totalFrames = scenes.reduce(
    (sum, s) => sum + Math.round((s.audio_duration || s.duration_seconds) * CONFIG.fps),
    0
  );

  const sceneImports = scenes
    .map((s, i) => `  s${i + 1}: { img: "images/scene_${s.scene_number}.jpg", audio: "audio/scene_${s.scene_number}.mp3", text: ${JSON.stringify(s.narration_text)}, duration: ${Math.round((s.audio_duration || s.duration_seconds) * CONFIG.fps)}, mood: "${s.mood}" },`)
    .join("\n");

  return `/**
 * VideoComposition.tsx — Main video composition
 * Auto-generated by Editor Agent
 * Topic: ${script.topic}
 * Duration: ${script.total_duration}s (${totalFrames} frames @ ${CONFIG.fps}fps)
 */

import React from "react";
import { Composition, staticFile } from "remotion";
import { Scene } from "./Scene";

// ─── Scene Assets ───────────────────────────────────────────────
const SCENES = {
${sceneImports}
};

// ─── Calculate cumulative offsets ───────────────────────────────
const sceneKeys = Object.keys(SCENES) as Array<keyof typeof SCENES>;
let cumulativeFrames = 0;
const sceneOffsets: Record<string, number> = {};
for (const key of sceneKeys) {
  sceneOffsets[key] = cumulativeFrames;
  cumulativeFrames += SCENES[key].duration;
}

// ─── Main Composition ───────────────────────────────────────────
export const VideoComposition: React.FC = () => {
  return (
    <>
      {sceneKeys.map((key) => {
        const scene = SCENES[key];
        return (
          <Scene
            key={key}
            imagePath={scene.img}
            audioPath={scene.audio}
            narrationText={scene.text}
            durationInFrames={scene.duration}
            sceneNumber={sceneKeys.indexOf(key) + 1}
            mood={scene.mood}
          />
        );
      })}
    </>
  );
};

// ─── Remotion Composition Registration ──────────────────────────
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="VideoComposition"
        component={VideoComposition}
        durationInFrames={${totalFrames}}
        fps={${CONFIG.fps}}
        width={${CONFIG.videoWidth}}
        height={${CONFIG.videoHeight}}
        defaultProps={{}}
      />
    </>
  );
};
`;
}

/**
 * Generate remotion.config.ts
 */
function generateRemotionConfig(): string {
  return `import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setCodec("h264");
Config.setCrf(18);
Config.setPixelFormat("yuv420p");
`;
}

/**
 * Generate src/index.ts entry point
 */
function generateIndexTs(): string {
  return `import { registerRoot } from "remotion";
import { RemotionRoot } from "./components/VideoComposition";

registerRoot(RemotionRoot);
`;
}

/**
 * Main Editor function
 */
export async function runEditor(): Promise<void> {
  logger.agent("Editor", "🎬 Starting Editor Agent...");

  const scriptPath = path.join(CONFIG.dataDir, "script.json");
  let script: Script;

  try {
    script = readJSON<Script>(scriptPath);
  } catch {
    throw new Error(`${scriptPath} not found. Run previous agents first.`);
  }

  // Validate all assets exist
  for (const scene of script.scenes) {
    const imgPath = path.join(CONFIG.imagesDir, `scene_${scene.scene_number}.jpg`);
    const audioPath = path.join(CONFIG.audioDir, `scene_${scene.scene_number}.mp3`);
    if (!fs.existsSync(imgPath)) {
      logger.warn(`Missing image: ${imgPath}`);
    }
    if (!fs.existsSync(audioPath)) {
      logger.warn(`Missing audio: ${audioPath}`);
    }
  }

  // Write Scene component
  fs.writeFileSync(SCENE_PATH, generateSceneComponent());
  logger.success(`Scene component written to ${SCENE_PATH}`);

  // Write VideoComposition
  fs.writeFileSync(COMPOSITION_PATH, generateVideoComposition(script));
  logger.success(`VideoComposition written to ${COMPOSITION_PATH}`);

  // Write index.ts
  fs.writeFileSync(INDEX_PATH, generateIndexTs());
  logger.success(`Entry point written to ${INDEX_PATH}`);

  // Write remotion.config.ts
  fs.writeFileSync(REMOTION_CONFIG_PATH, generateRemotionConfig());
  logger.success(`Remotion config written to ${REMOTION_CONFIG_PATH}`);

  logger.success("Editor Agent completed! Run `npx remotion render` to produce video.");
}

// CLI
if (require.main === module) {
  runEditor()
    .then(() => process.exit(0))
    .catch((err) => { logger.error(err.message); process.exit(1); });
}
