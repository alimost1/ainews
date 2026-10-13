/**
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
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Subtle zoom effect (Ken Burns)
  const scale = interpolate(
    frame,
    [0, durationInFrames],
    [1, 1.08],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Text slide-up animation
  const textY = interpolate(
    frame,
    [5, 25],
    [30, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
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
  const isRTL = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(narrationText);
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
          transform: `scale(${scale})`,
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
          transform: `translateY(${textY}px)`,
          opacity,
        }}
      >
        <div
          style={{
            backgroundColor: "rgba(0,0,0,0.65)",
            borderRadius: 16,
            padding: `${textPadding}px ${Math.round(textPadding * 1.2)}px`,
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
