/**
 * property-compose.ts — Generates a per-job Remotion project for the property
 * presentation: vertical 1080x1920, real property photos full-bleed with Ken
 * Burns pan/zoom and smooth crossfades, avatar clip in a small rounded panel
 * (bottom-right, clear of captions), captions with RTL support.
 *
 * Only facts from the reviewed listing appear as captions.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { planGallery, frameTimeline, type GalleryAsset } from "./property-cinematic";
import type { PropJobInput } from "./property-presentation";

export interface SegmentPlan {
  text: string;
  audioFile: string; // staticFile path e.g. audio/seg_01.mp3
  avatarClip: string; // staticFile path e.g. avatar/seg_01.mp4
  durationSec: number; // ffprobe-measured audio duration
  photoFile?: string; // staticFile path e.g. photos/photo_01.jpg (tour scenes)
  caption?: string; // highlight caption (verified facts only)
}

export function planCaptions(input: PropJobInput, lang: string): { opening: string; highlights: string[]; closing: string } {
  const L = input.listing;
  const t = (fr: string, ar: string, en: string) => (lang === "ar" ? ar : lang === "en" ? en : fr);
  const highlights: string[] = [];
  if (L.location) highlights.push(L.location);
  if (L.landAreaM2 != null) highlights.push(t(`${L.landAreaM2} m² ${"terrain"}`, `${L.landAreaM2} م²`, `${L.landAreaM2} m² land`));
  if (L.bedrooms != null) highlights.push(t(`${L.bedrooms} chambres`, `${L.bedrooms} غرف`, `${L.bedrooms} bedrooms`));
  if (L.bathrooms != null) highlights.push(t(`${L.bathrooms} SDB`, `${L.bathrooms} حمامات`, `${L.bathrooms} baths`));
  if (L.price != null) highlights.push(`${L.price.toLocaleString(lang === "ar" ? "ar-MA" : lang === "en" ? "en-US" : "fr-MA")} ${L.priceCurrency || ""}`.trim());
  return {
    opening: L.title || "",
    highlights,
    closing: t(
      `Contactez ${input.branding.agencyName} pour plus d'informations ou une visite`,
      `تواصلوا مع ${input.branding.agencyName} للمزيد من المعلومات أو لتحديد زيارة`,
      `Contact ${input.branding.agencyName} for more information or a visit`,
    ),
  };
}

/** Emit the per-job Remotion project (index.tsx + props). */
export function generateRemotionProject(opts: {
  jobDir: string;
  plan: SegmentPlan[];
  input: PropJobInput;
  fps: number;
  gallery?: GalleryAsset[];
}): { entryDir: string } {
  const { jobDir, plan, input, fps } = opts;
  const entryDir = path.join(jobDir, "render");
  const pub = path.join(entryDir, "public");
  for (const d of [entryDir, pub, path.join(pub, "avatar"), path.join(pub, "photos"), path.join(pub, "audio")]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const caps = planCaptions(input, input.language);
  const timeline = frameTimeline(plan.map(s => s.durationSec), fps);
  const totalFrames = timeline.reduce((sum, s) => sum + s.duration, 0);
  const assets: GalleryAsset[] = opts.gallery || plan.filter(s => s.photoFile).map(s => ({photo: s.photoFile!}));
  // Pre-blur photo backgrounds with ffmpeg once per asset; per-frame blur(40px) on
  // full-bleed layers is the dominant raster cost of the composition.
  const blurBin = process.env.FFMPEG_BIN || "ffmpeg";
  for (const a of assets) {
    const src = path.join(pub, a.photo);
    const rel = a.photo.replace(/([^/]+)\.jpg$/, "blur_$1.jpg");
    const dst = path.join(pub, rel);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        execFileSync(blurBin, ["-v", "error", "-y", "-i", src, "-vf", "scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080,boxblur=20:2,eq=brightness=-0.45", "-q:v", "5", dst]);
      } catch { /* fall back to in-browser blur below */ }
    }
    if (fs.existsSync(dst)) a.blur = rel;
  }
  const data = {
    fps, totalFrames, language: input.language, rtl: input.language === "ar", title: input.listing.title,
    location: input.listing.location, reference: input.listing.reference,
    price: input.listing.price == null ? "" : `${input.listing.price.toLocaleString(input.language === "ar" ? "ar-MA" : "fr-FR")} ${input.listing.priceCurrency || ""}`,
    agency: input.branding.agencyName, contact: input.branding.contactLine,
    highlights: caps.highlights, closing: caps.closing, aiMotion: assets.some(a => !!a.video),
    segments: plan.map((s, i) => ({ ...timeline[i], audio: s.audioFile, avatar: s.avatarClip })),
    shots: planGallery(assets, totalFrames, fps),
  };
  fs.writeFileSync(path.join(entryDir, "segments.json"), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(entryDir, "index.tsx"), `import React from 'react';
import {registerRoot, Composition} from 'remotion';
import {PropertyPresentation} from './Presentation';
const data = ${JSON.stringify(data)};
const Root: React.FC = () => <Composition id="PropertyPresentation" component={PropertyPresentation}
  durationInFrames={data.totalFrames} fps={data.fps} width={1080} height={1920} defaultProps={data}/>;
registerRoot(Root);
`);

  // package.json + tsconfig so remotion resolves deps upward and compiles JSX
  // Project root: walk up from this file until the ianews package.json is found
  // (dist/ and src/ sit at different depths, so a fixed relative hop is fragile).
  let rootDir = __dirname;
  for (let i = 0; i < 6; i++) {
    const pkgPath = path.join(rootDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "ianews") break;
      } catch { /* keep walking */ }
    }
    rootDir = path.dirname(rootDir);
  }
  fs.copyFileSync(path.join(rootDir, "src", "components", "PropertyPresentation.tsx"), path.join(entryDir, "Presentation.tsx"));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
  fs.writeFileSync(path.join(entryDir, "package.json"), JSON.stringify({
    name: "ianews-prop-" + path.basename(jobDir),
    private: true,
    dependencies: rootPkg.dependencies,
  }, null, 2));
  fs.writeFileSync(path.join(entryDir, "tsconfig.json"), JSON.stringify({
    extends: path.relative(entryDir, path.join(rootDir, "tsconfig.json")),
    compilerOptions: { jsx: "react-jsx", module: "esnext", moduleResolution: "bundler" },
  }, null, 2));

  return { entryDir };
}

/** remotion.config.ts content (same as main app). */
export const REMOTION_CONFIG = `import { Config } from "@remotion/cli/config";
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setCodec("h264");
Config.setCrf(18);
Config.setPixelFormat("yuv420p");
// OffthreadVideo decode of full-frame clips on small hosts can exceed the 30s default
Config.setDelayRenderTimeoutInMilliseconds(120000);
// Parallel page contexts exhaust small-host memory with embedded clips
Config.setConcurrency(2);
`;
