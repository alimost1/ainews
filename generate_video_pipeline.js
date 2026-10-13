#!/usr/bin/env node
// generate_video_pipeline.js — iAnews pipeline: Higgsfield scene videos + ElevenLabs TTS + ffmpeg assembly
//
// Usage: node generate_video_pipeline.js [--scenes=1,2,3] [--dry-run]
// Requires in /root/ainews/.env:
//   HF_API_KEY_ID / HF_API_KEY_SECRET   (open.higgsfield.ai)
//   ELEVENLABS_API_KEY                  (elevenlabs.io)
//   HF_VIDEO_MODEL  (default: wan/v2.7/text-to-video)
//   ELEVEN_VOICE_ID (default: eleven_multilingual_v2 default voice JBFqnCBsd6RMkjVDRZzb)
//
// Flow per scene: ElevenLabs narration (mp3) -> Higgsfield text-to-video (scene image_prompt,
//   duration = scene duration_seconds) -> download video -> mux narration over it.
// Final: concat all scenes -> output/video_final.mp4

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT = '/root/ainews';
require('dotenv').config({ path: path.join(PROJECT, '.env') });

const HF_KEY_ID = process.env.HF_API_KEY_ID;
const HF_KEY_SECRET = process.env.HF_API_KEY_SECRET;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const HF_MODEL = process.env.HF_VIDEO_MODEL || 'wan/v2.7/text-to-video';
const VOICE_ID = process.env.ELEVEN_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
const RESOLUTION = process.env.VIDEO_RESOLUTION || '720p';
const ASPECT = process.env.VIDEO_ASPECT_RATIO || '16:9';

const OUT_VIDEOS = path.join(PROJECT, 'public', 'videos');
const OUT_AUDIO = path.join(PROJECT, 'public', 'audio');
const OUTPUT = path.join(PROJECT, 'output');
[OUT_VIDEOS, OUT_AUDIO, OUTPUT].forEach(d => fs.mkdirSync(d, { recursive: true }));

const DRY_RUN = process.argv.slice(2).includes('--dry-run');
if (!DRY_RUN) {
  if (!HF_KEY_ID || !HF_KEY_SECRET) { console.error('❌ Missing HF_API_KEY_ID / HF_API_KEY_SECRET in .env'); process.exit(1); }
  if (!ELEVEN_KEY) { console.error('❌ Missing ELEVENLABS_API_KEY in .env'); process.exit(1); }
}

const HF_AUTH = `Key ${HF_KEY_ID}:${HF_KEY_SECRET}`;
const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hfFetch(url, opts = {}, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500 && i < retries) { await sleep(5000 * i); continue; }
      return res;
    } catch (e) {
      if (i === retries) throw e;
      await sleep(5000 * i);
    }
  }
}

async function elevenTTS(text, outFile, lang) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${t.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outFile, buf);
  return buf.length;
}

async function hfGenerateVideo(prompt, duration, outFile, sceneNum) {
  const submit = await hfFetch(`https://api.higgsfield.ai/${HF_MODEL}`, {
    method: 'POST',
    headers: { Authorization: HF_AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      resolution: RESOLUTION,
      aspect_ratio: ASPECT,
      duration: Math.min(Math.max(Math.round(duration), 2), 15),
    }),
  });
  const submitBody = await submit.json();
  if (!submit.ok) throw new Error(`Higgsfield submit ${submit.status}: ${JSON.stringify(submitBody).slice(0, 200)}`);

  const { request_id, status_url } = submitBody;
  if (!status_url) throw new Error(`Higgsfield returned no status_url: ${JSON.stringify(submitBody).slice(0, 200)}`);
  console.log(`   scene ${sceneNum}: request_id=${request_id}`);

  // Poll with backoff (2s -> 10s, per docs)
  let delay = 2000, lastStatus = submitBody.status;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(delay * 1.5, 10000);
    const poll = await hfFetch(status_url, { headers: { Authorization: HF_AUTH } });
    if (!poll.ok) { console.log(`   poll ${poll.status}, retrying`); continue; }
    const d = await poll.json();
    if (d.status !== lastStatus) { console.log(`   status: ${d.status}`); lastStatus = d.status; }
    if (TERMINAL.has(d.status)) {
      if (d.status !== 'completed') throw new Error(`Higgsfield terminal status ${d.status}: ${JSON.stringify(d.error || d).slice(0, 200)}`);
      const videoUrl = d.video?.url || d.output?.video?.url;
      if (!videoUrl) throw new Error(`No video URL in completed response: ${JSON.stringify(d).slice(0, 300)}`);
      const dl = await fetch(videoUrl);
      if (!dl.ok) throw new Error(`Download failed ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      fs.writeFileSync(outFile, buf);
      return { bytes: buf.length, requestId: request_id };
    }
  }
  throw new Error('Higgsfield polling timeout (15 min)');
}

function probeDuration(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return parseFloat(out.trim());
}

async function main() {
  const dryRun = DRY_RUN;
  const args = process.argv.slice(2);
  const scenesArg = args.find(a => a.startsWith('--scenes='));
  const wanted = scenesArg ? scenesArg.split('=')[1].split(',').map(Number) : null;

  const script = JSON.parse(fs.readFileSync(path.join(PROJECT, 'data', 'script.json'), 'utf8'));
  const scenes = wanted ? script.scenes.filter(s => wanted.includes(s.scene_number)) : script.scenes;
  console.log(`🎬 Pipeline: ${scenes.length} scene(s), model=${HF_MODEL}, ${RESOLUTION} ${ASPECT}, voice=${VOICE_ID}`);
  if (dryRun) { scenes.forEach(s => console.log(`  scene ${s.scene_number}: ${s.duration_seconds}s — ${s.image_prompt.slice(0, 80)}...`)); return; }

  for (const scene of scenes) {
    const n = scene.scene_number;
    const vidFile = path.join(OUT_VIDEOS, `scene_${String(n).padStart(2, '0')}.mp4`);
    const audFile = path.join(OUT_AUDIO, `scene_${String(n).padStart(2, '0')}.mp3`);
    const muxFile = path.join(OUT_VIDEOS, `scene_${String(n).padStart(2, '0')}_voiced.mp4`);
    console.log(`\n▶ Scene ${n}: ${scene.duration_seconds}s`);

    // 1. TTS narration
    if (fs.existsSync(audFile) && fs.statSync(audFile).size > 1000) {
      console.log(`   audio exists (${(fs.statSync(audFile).size / 1024).toFixed(0)} KB), skipping TTS`);
    } else {
      process.stdout.write('   ElevenLabs TTS… ');
      const bytes = await elevenTTS(scene.narration_text, audFile, script.lang);
      console.log(`✓ (${(bytes / 1024).toFixed(0)} KB)`);
    }


    // 2. Higgsfield video
    if (fs.existsSync(vidFile) && fs.statSync(vidFile).size > 10000) {
      console.log(`   video exists (${(fs.statSync(vidFile).size / 1024 / 1024).toFixed(1)} MB), skipping generation`);
    } else {
      const r = await hfGenerateVideo(scene.image_prompt, scene.duration_seconds, vidFile, n);
      console.log(`   Higgsfield ✓ (${(r.bytes / 1024 / 1024).toFixed(1)} MB)`);
    }

    // 3. Mux: narration audio over video (video audio removed, narration kept; loop video if shorter than audio)
    const vDur = probeDuration(vidFile);
    const aDur = probeDuration(audFile);
    console.log(`   mux: video ${vDur.toFixed(1)}s + narration ${aDur.toFixed(1)}s`);
    execFileSync('ffmpeg', ['-y', '-stream_loop', '-1', '-i', vidFile, '-i', audFile,
      '-map', '0:v:0', '-map', '1:a:0',
      '-t', String(Math.max(vDur, aDur)),
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-shortest',
      muxFile], { stdio: 'pipe' });
    console.log(`   muxed ✓`);
  }

  // 4. Concat
  const listFile = path.join(OUTPUT, 'concat_pipeline.txt');
  const concatFiles = scenes.map(s => path.join(OUT_VIDEOS, `scene_${String(s.scene_number).padStart(2, '0')}_voiced.mp4`));
  fs.writeFileSync(listFile, concatFiles.map(f => `file '${f}'`).join('\n'));
  const finalFile = path.join(OUTPUT, 'video_final.mp4');
  execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', finalFile], { stdio: 'pipe' });
  const size = (fs.statSync(finalFile).size / 1024 / 1024).toFixed(1);
  console.log(`\n✅ Final video: ${finalFile} (${size} MB, ${probeDuration(finalFile).toFixed(1)}s)`);
}

main().catch(e => { console.error('\n❌', e.message); process.exit(1); });
