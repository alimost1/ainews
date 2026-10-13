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
    highlights: highlights.slice(0, 4),
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
}): { entryDir: string } {
  const { jobDir, plan, input, fps } = opts;
  const entryDir = path.join(jobDir, "render");
  const pub = path.join(entryDir, "public");
  for (const d of [entryDir, pub, path.join(pub, "avatar"), path.join(pub, "photos"), path.join(pub, "audio")]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const caps = planCaptions(input, input.language);
  const lang = input.language;
  const rtl = lang === "ar";

  // Segments: build timeline entries with measured durations
  const segJson = plan.map((s, i) => ({
    i,
    audio: s.audioFile,
    avatar: s.avatarClip,
    photo: s.photoFile || null,
    caption: i === 0 ? caps.opening : (i === plan.length - 1 ? caps.closing : (s.caption || "")),
    duration: s.durationSec,
  }));

  fs.writeFileSync(path.join(entryDir, "segments.json"), JSON.stringify(segJson, null, 2));

  // Props are static-file relative paths resolved via staticFile() in the component.
  const indexTsx = `import React from "react";
import { registerRoot, Composition, Sequence, Img, Video, Audio, staticFile, useCurrentFrame, useVideoConfig, interpolate, Easing, AbsoluteFill } from "remotion";

/**
 * Property presentation — auto-generated. Photos are the REAL listing photos;
 * the presenter is shown in a small panel and is never composited as physically
 * present in the property. Captions use reviewed facts only.
 */
const SEGMENTS: Array<{i:number; audio:string; avatar:string; photo:string|null; caption:string; duration:number}> = ${JSON.stringify(segJson)};
const FPS = ${fps};
const RTL = ${rtl};
const LANG = ${JSON.stringify(lang)};

const AVATAR_W = 340, AVATAR_H = 460; // small panel; keeps clear of captions

const PhotoFrame: React.FC<{photo:string; from:number; dur:number}> = ({photo, from, dur}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [from, from + dur], [1.04, 1.12], {extrapolateLeft:"clamp", extrapolateRight:"clamp"});
  const x = interpolate(frame, [from, from + dur], [-20, 20], {extrapolateLeft:"clamp", extrapolateRight:"clamp"});
  return (
    <AbsoluteFill>
      <Img src={staticFile(photo)} style={{width:"100%",height:"100%",objectFit:"cover",
        transform:\`scale(\${scale}) translateX(\${x}px)\`}} />
      {/* darkening for caption readability, photo unchanged otherwise */}
      <AbsoluteFill style={{background:"linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.25) 28%, rgba(0,0,0,0) 55%)"}} />
    </AbsoluteFill>
  );
};

const AvatarPanel: React.FC<{clip:string}> = ({clip}) => {
  const frame = useCurrentFrame();
  const pop = interpolate(frame, [0, 10], [0.85, 1], {extrapolateRight:"clamp", easing: Easing.out(Easing.cubic)});
  return (
    <div style={{position:"absolute", right:28, bottom: 340, width:AVATAR_W, height:AVATAR_H,
      borderRadius:26, overflow:"hidden", transform:\`scale(\${pop})\`,
      border:"3px solid rgba(255,255,255,0.85)", boxShadow:"0 12px 40px rgba(0,0,0,0.45)", zIndex:5}}>
      <Video src={staticFile(clip)} style={{width:"100%",height:"100%",objectFit:"cover"}} muted />
    </div>
  );
};

const CaptionBar: React.FC<{text:string}> = ({text}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 8, 40, 50], [0, 1, 1, 1], {extrapolateRight:"clamp"});
  const y = interpolate(frame, [0, 8], [26, 0], {extrapolateRight:"clamp", easing: Easing.out(Easing.cubic)});
  return (
    <div style={{position:"absolute", left:36, right:36, bottom:120, zIndex:6, opacity,
      transform:\`translateY(\${y}px)\`}}>
      <div style={{backgroundColor:"rgba(10,10,18,0.62)", backdropFilter:"blur(10px)",
        borderRadius:18, padding:"22px 30px", border:"1px solid rgba(255,255,255,0.14)"}}>
        <p style={{margin:0, color:"#fff", fontSize:44, fontWeight:700, lineHeight:1.35,
          fontFamily: RTL ? "'Noto Sans Arabic','Segoe UI',Tahoma,sans-serif" : "'Segoe UI','Noto Sans',sans-serif",
          direction: RTL?"rtl":"ltr", textAlign: RTL?"right":"left",
          textShadow:"0 2px 14px rgba(0,0,0,0.6)"}}>{text}</p>
      </div>
    </div>
  );
};

const BrandStrip: React.FC<{name:string}> = ({name}) => (
  <div style={{position:"absolute", top:44, left:36, right:36, zIndex:6,
    display:"flex", justifyContent: RTL?"flex-start":"flex-end"}}>
    <div style={{backgroundColor:"rgba(31,74,191,0.8)", color:"#fff", fontSize:26, fontWeight:700,
      padding:"10px 24px", borderRadius:999, letterSpacing:0.4}}>{name}</div>
  </div>
);

const Segment: React.FC<{seg:(typeof SEGMENTS)[number]; from:number}> = ({seg, from}) => {
  const frame = useCurrentFrame();
  const local = frame - from;
  const fade = interpolate(local, [0, 12], [0, 1], {extrapolateRight:"clamp"});
  const fadeOut = interpolate(local, [seg.duration*FPS-12, seg.duration*FPS], [1, 0], {extrapolateLeft:"clamp", extrapolateRight:"clamp"});
  const opacity = Math.min(fade, fadeOut);
  return (
    <AbsoluteFill style={{opacity}}>
      {seg.photo ? <PhotoFrame photo={seg.photo} from={from} dur={seg.duration*FPS}/> : <AbsoluteFill style={{background:"linear-gradient(160deg,#0f0c29,#1a1633 55%,#24243e)"}}/>}
      <AvatarPanel clip={seg.avatar}/>
      {seg.caption ? <CaptionBar text={seg.caption}/> : null}
      <Audio src={staticFile(seg.audio)}/>
    </AbsoluteFill>
  );
};

const Presentation: React.FC = () => {
  let acc = 0;
  const starts = SEGMENTS.map(s => { const f = Math.round(acc*FPS); acc += s.duration; return f; });
  const total = Math.ceil(acc*FPS);
  return (
    <AbsoluteFill style={{backgroundColor:"#000"}}>
      {SEGMENTS.map((seg, idx) => (
        <Sequence key={seg.i} from={starts[idx]} durationInFrames={Math.round(seg.duration*FPS)}>
          <Segment seg={seg} from={starts[idx]}/>
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

const Root: React.FC = () => (
  <Composition id="PropertyPresentation" component={Presentation}
    durationInFrames={Math.ceil(SEGMENTS.reduce((a,s)=>a+s.duration,0)*FPS)}
    fps={FPS} width={1080} height={1920} defaultProps={{}}/>
);
registerRoot(Root);
`;

  fs.writeFileSync(path.join(entryDir, "index.tsx"), indexTsx);

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
  const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
  fs.writeFileSync(path.join(entryDir, "package.json"), JSON.stringify({
    name: "ianews-prop-" + path.basename(jobDir),
    private: true,
    dependencies: rootPkg.dependencies,
  }, null, 2));
  fs.writeFileSync(path.join(entryDir, "tsconfig.json"), JSON.stringify({
    extends: path.relative(entryDir, path.join(__dirname, "../../..", "tsconfig.json")),
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
`;
