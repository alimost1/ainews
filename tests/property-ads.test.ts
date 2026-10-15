import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {planGallery,validateEditStyle} from '../src/pipeline/property-cinematic';
import {prepareTransparentPresenter,alphaCoverage} from '../src/pipeline/property-matte';
import {presenterReferencePrompt} from '../src/pipeline/property-presenter';
import {generateRemotionProject} from '../src/pipeline/property-compose';

test('ad cuts every two seconds with a short crossfade; tour stays slower',()=>{
 const assets=[{photo:'one.jpg'},{photo:'two.jpg'}];
 const ad=planGallery(assets,600,30,'ad'), tour=planGallery(assets,600,30,'tour');
 assert.equal(ad.length,10); assert.equal(tour.length,5);
 assert.equal(ad[1].from,60); assert.equal(ad[0].transitionFrames,5);
 assert.equal(ad.at(-1)!.from+ad.at(-1)!.duration,600);
 assert.equal(validateEditStyle(undefined),'ad');
 assert.throws(()=>validateEditStyle('unbounded'));
});

test('reference requires green screen and leaves the mouth unobstructed',()=>{
 const prompt=presenterReferencePrompt();
 assert.match(prompt,/0 255 0/); assert.match(prompt,/Mouth unobstructed/);
 assert.doesNotMatch(prompt,/warm-grey studio/);
});

test('real ffmpeg output preserves animated foreground and removes green background',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-alpha-'));
 try {
  const src=path.join(dir,'green.mp4'),dst=path.join(dir,'alpha.webm');
  execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=0x00FF00:s=96x128:r=30:d=0.5',
   '-vf','drawbox=x=30:y=15:w=40:h=95:color=red:t=fill','-c:v','libx264','-pix_fmt','yuv420p',src]);
  await prepareTransparentPresenter(src,dst,.5);
  const coverage=alphaCoverage(dst);
  assert.ok(coverage.transparent>.5); assert.ok(coverage.opaque>.1);
  const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',dst],{encoding:'utf8'}));
  assert.equal(info.streams[0].codec_name,'vp9');
  assert.ok(info.streams[0].nb_frames===undefined || Number(info.streams[0].nb_frames)>1);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('opaque non-green footage fails visibly instead of silently exporting no presenter',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-opaque-'));
 try {
  const src=path.join(dir,'opaque.mp4'),dst=path.join(dir,'alpha.webm');
  execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=96x128:r=30:d=0.2','-c:v','libx264',src]);
  await assert.rejects(prepareTransparentPresenter(src,dst,.2),/background removal failed/);
  assert.equal(fs.existsSync(dst),false);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('presenter playback follows segment clock, not gallery cuts, and uses the exact segment audio',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-compose-'));
 try {
 const input:any={language:'fr',editStyle:'ad',listing:{title:'Villa',location:'Marrakech',reference:'R',price:1,priceCurrency:'MAD'},branding:{agencyName:'A',contactLine:'C'}};
 const plan=[0,1].map(i=>({text:'Speech',audioFile:`audio/${i}.mp3`,avatarClip:`avatar/${i}.mp4`,presenterAlpha:`presenter/${i}.webm`,durationSec:4}));
 const {entryDir}=generateRemotionProject({jobDir:dir,plan,input,fps:30,mode:'presenter',gallery:[{photo:'one.jpg'},{photo:'two.jpg'}]});
 const data=JSON.parse(fs.readFileSync(path.join(entryDir,'segments.json'),'utf8'));
 assert.equal(data.shots.length,4); assert.equal(data.segments.length,2);
 assert.deepEqual(data.segments.map((s:any)=>s.from),[0,120]);
 assert.deepEqual(data.segments.map((s:any)=>s.audio),['audio/0.mp3','audio/1.mp3']);
 assert.ok(data.shots.every((s:any)=>!s.avatar));
 const component=fs.readFileSync(path.join(entryDir,'Presentation.tsx'),'utf8');
 assert.match(component,/s.presenterAlpha!/); assert.match(component,/transparent muted/);
 assert.doesNotMatch(component,/playbackRate|stream_loop/);
 assert.throws(()=>generateRemotionProject({jobDir:dir,plan:[{...plan[0],presenterAlpha:undefined}],input,fps:30,mode:'presenter',gallery:[{photo:'a'}]}),/Transparent presenter missing/);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
