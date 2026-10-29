import React from 'react';
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame } from 'remotion';

export interface PresentationData {
  fps: number; rtl: boolean; totalFrames: number; language?: string;
  title: string; location: string; reference: string; price: string;
  agency: string; contact: string; highlights: string[]; closing: string; aiMotion: boolean;
  editStyle?: 'ad' | 'tour'; mode?: 'panel' | 'presenter'; disclosure?: string;
  segments: { from: number; duration: number; audio: string; avatar: string; presenterAlpha?: string }[];
  shots: { transitionFrames?: number; from: number; duration: number; index: number; photo: string; video?: string; blur?: string; presenter?: boolean; avatar?: string; presenterPos?: 'left' | 'right' | 'center' }[];
}

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const gold = '#E7C58A';

/** Photo component - uses pre-composited scene images for presenter mode. */
const Photo: React.FC<{ shot: PresentationData['shots'][number]; fps: number; ad?: boolean }> = ({ shot, fps, ad }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, shot.duration], [0, 1], clamp);
  const fade = shot.index === 0 ? 1 : interpolate(frame, [0, (shot.transitionFrames ?? fps * .4)], [0, 1], clamp);
  const scale = shot.index % 2 ? 1.08 - progress * .06 : 1.02 + progress * .06;
  const x = (shot.index % 2 ? -1 : 1) * (progress - .5) * 22;

  return <AbsoluteFill style={{ opacity: fade, background: '#101716' }}>
    <Img src={staticFile(shot.blur || shot.photo)} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: `brightness(.4)${shot.blur ? '' : ' blur(40px)'}`, transform: 'scale(1.15)' }} />
    <AbsoluteFill style={{ justifyContent: 'center', transform: `translateX(${x}px) scale(${scale})` }}>
      {shot.video ? <OffthreadVideo src={staticFile(shot.video)} muted style={{ width: '100%', height: '100%', objectFit: ad ? 'cover' : 'contain' }} />
        : <Img src={staticFile(shot.photo)} style={{ width: '100%', height: '100%', objectFit: ad ? 'cover' : 'contain' }} />}
    </AbsoluteFill>
  </AbsoluteFill>;
};

export const PropertyPresentation: React.FC<PresentationData> = data => {
  const frame = useCurrentFrame();
  const opening = frame < data.fps * 3;
  const closing = frame >= data.totalFrames - data.fps * 4;
  const active = data.segments.findIndex(s => frame >= s.from && frame < s.from + s.duration);
  const factIndex = Math.floor(Math.max(0, frame / data.fps - 2) / (data.editStyle === "ad" ? 2 : 3.6)) % Math.max(1, data.highlights.length);
  const entry = interpolate(frame, [0, 22], [40, 0], clamp);
  const opacity = interpolate(frame, [0, 16], [0, 1], clamp);
  const panelWidth = opening || closing ? 290 : 230;
  const presenterMode = data.mode === 'presenter';

  return <AbsoluteFill style={{ background: '#101716', color: 'white', fontFamily: "'Noto Sans Arabic','Segoe UI',Tahoma,sans-serif", direction: data.rtl ? 'rtl' : 'ltr' }}>
    {data.shots.map(s => <Sequence key={s.index} from={s.from} durationInFrames={s.duration}><Photo shot={s} fps={data.fps} ad={data.editStyle === "ad"} /></Sequence>)}
    <AbsoluteFill style={{ background: 'linear-gradient(180deg,rgba(6,18,17,.85),transparent 30%,transparent 52%,rgba(6,18,17,.96))' }} />
    <div style={{ position: 'absolute', top: 86, left: 64, right: 64, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 25, letterSpacing: 2 }}>
      <span style={{ borderTop: `3px solid ${gold}`, paddingTop: 16 }}>{data.agency}</span>
      <span style={{ color: gold }}>{data.reference}</span>
    </div>
    <div style={{ position: 'absolute', top: 192, left: 64, right: 64, opacity, transform: `translateY(${entry}px)` }}>
      <div style={{ fontSize: 28, color: gold, marginBottom: 16 }}>{data.location}</div>
      <div style={{ fontSize: opening ? 58 : 40, lineHeight: 1.15, fontWeight: 650, maxWidth: 880 }}>{data.title}</div>
    </div>
    {data.segments.map((s, i) => <Sequence key={i} from={s.from} durationInFrames={s.duration}>
      <Audio src={staticFile(s.audio)} />
      {presenterMode ? <div style={{position:'absolute', bottom:440, right:data.rtl ? undefined : 28, left:data.rtl ? 28 : undefined,
        width:440, height:700, overflow:'hidden'}}>
        {/* Sequence-local playback starts once per narration segment, never per property cut. */}
        <OffthreadVideo src={staticFile(s.presenterAlpha!)} transparent muted
          style={{width:'100%',height:'100%',objectFit:'contain',objectPosition:'bottom'}} />
      </div> : <div style={{position:'absolute',bottom:460,right:48,width:panelWidth,height:panelWidth*1.3,borderRadius:22,overflow:'hidden'}}>
        {/* Check if avatar is a video or static image */}
        {s.avatar?.endsWith('.mp4') || s.avatar?.endsWith('.webm') ? (
          <OffthreadVideo src={staticFile(s.avatar)} muted style={{width:'100%',height:'100%',objectFit:'cover'}} />
        ) : (
          <Img src={staticFile(s.avatar)} style={{width:'100%',height:'100%',objectFit:'cover'}} />
        )}
      </div>}</Sequence>)}
    {presenterMode && <div style={{ position: 'absolute', top: 40, left: 64, fontSize: 20, color: '#d8e0dd', background: 'rgba(6,18,17,.6)', padding: '6px 14px', borderRadius: 8 }}>{data.disclosure}</div>}
    <div style={{ position: 'absolute', left: 64, right: 64, bottom: 180 }}>
      <div style={{ height: 3, width: 74, background: gold, marginBottom: 24 }} />
      <div key={closing ? 'closing' : factIndex} style={{ fontSize: closing ? 39 : 52, lineHeight: 1.25, fontWeight: 600, maxWidth: 910 }}>
        {closing ? data.closing : data.highlights[factIndex] || data.location}
      </div>
      <div style={{ color: gold, fontSize: 38, marginTop: 20 }}>{closing ? data.contact || data.price : data.price}</div>
    </div>
    <div style={{ position: 'absolute', bottom: 112, left: 64, right: 64, display: 'flex', justifyContent: 'space-between', fontSize: 19, color: '#d8e0dd' }}>
      <span>{data.language === 'ar' ? (data.aiMotion ? 'حركة بالذكاء الاصطناعي · صور الإعلان' : 'صور الإعلان') : data.language === 'en' ? (data.aiMotion ? 'AI motion · Listing photos' : 'Listing photos') : data.aiMotion ? 'Mouvement IA · Photos de l\'annonce' : 'Photos de l\'annonce'}</span>
      <span>{String(Math.max(0, active) + 1).padStart(2, '0')} / {String(data.segments.length).padStart(2, '0')}</span>
    </div>
    <div style={{ position: 'absolute', bottom: 88, left: 64, right: 64, height: 3, background: '#ffffff30' }}>
      <div style={{ height: '100%', width: `${100 * frame / Math.max(1, data.totalFrames - 1)}%`, background: gold }} />
    </div>
  </AbsoluteFill>;
};