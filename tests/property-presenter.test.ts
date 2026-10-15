/**
 * Presenter-in-scene mode: model config, prompt builders, alternating edit plan,
 * resumable image generation with a MOCKED provider (no real API calls, no billing),
 * and compose-mode wiring in the generated Remotion project.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const presenter: any = require('../src/pipeline/property-presenter');
const compose: any = require('../src/pipeline/property-compose');
const pipeline: any = require('../src/pipeline/property-presentation');

const INPUT = {
  sourceUrl: 'https://example.com/x',
  listing: {
    title: 'Villa Test', reference: 'REF-1', location: 'Casa',
    price: 1000000, priceCurrency: 'MAD', landAreaM2: 400, builtAreaM2: 250,
    bedrooms: 4, bathrooms: 3, description: '', amenities: [],
    images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
  },
  narration: 'narration longue pour les tests de segmentation de la vidéo',
  language: 'fr', voiceId: 'V', branding: { agencyName: 'Agence', contactLine: '' },
};

function mockFetchSequence(steps: Array<{ status?: number; body: any }>) {
  const calls: { url: string; method: string }[] = [];
  const impl = async (url: any, init: any) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    const step = steps.shift()!;
    return {
      ok: (step.status || 200) < 400, status: step.status || 200,
      json: async () => step.body,
    } as any;
  };
  return { impl: impl as any, calls };
}

// ── Prompt builders & config ─────────────────────────────────────────

test('PRESENTER_MODEL uses the verified Soul 2 text-to-image endpoint', () => {
  assert.equal(presenter.PRESENTER_MODEL.id, 'higgsfield-ai/soul/v2/standard');
  assert.equal(presenter.PRESENTER_MODEL.url, 'https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard');
});

test('presenterReferencePrompt specifies a synthetic male Moroccan presenter, waist-up, navy blazer', () => {
  const p = presenter.presenterReferencePrompt();
  assert.match(p, /male Moroccan presenter/i);
  assert.match(p, /waist-up/i);
  assert.match(p, /navy blazer/i);
  assert.match(p, /[Pp]hotorealistic/);
  assert.match(p, /[Ss]ingle person/);
});

test('scenePrepPrompt places a photorealistic presenter beside the villa and preserves watermarks', () => {
  const p = presenter.scenePrepPrompt(INPUT);
  assert.match(p, /photorealistic male presenter standing beside the villa/i);
  assert.match(p, /watermarks.*untouched/i);
  assert.match(p, /Do not add or remove rooms/i);
  assert.match(p, /[Ee]dit this exact property photo/);
});

test('presenterDisclosure is localized and always states the presenter is AI-generated', () => {
  assert.match(presenter.presenterDisclosure('fr'), /généré par IA/i);
  assert.match(presenter.presenterDisclosure('en'), /AI-generated/i);
  assert.match(presenter.presenterDisclosure('ar'), /الذكاء الاصطناعي/);
});

test('validatePresenterMode defaults to panel and rejects unknown modes', () => {
  assert.equal(presenter.validatePresenterMode(undefined), 'panel');
  assert.equal(presenter.validatePresenterMode('panel'), 'panel');
  assert.equal(presenter.validatePresenterMode('presenter'), 'presenter');
  assert.throws(() => presenter.validatePresenterMode('hologram'), /panel.*presenter/i);
});

// ── Alternating edit plan ────────────────────────────────────────────

test('property gallery never carries speaking clips or undefined photos', () => {
  const photos = ['photos/p1.jpg', 'photos/p2.jpg'];
  const plan = presenter.planPresenterShots(photos, ['a.mp4', 'b.mp4', 'c.mp4']);
  assert.deepEqual(plan, photos.map(photo => ({photo})));
});

// ── Resumable, never-duplicate image generation (mocked provider) ────

test('generateSoulImage submits once, polls, and returns the HTTPS image URL', async () => {
  const { impl, calls } = mockFetchSequence([
    { body: { request_id: 'req_1', status_url: 'https://api.higgsfield.ai/requests/req_1' } },
    { body: { status: 'queued' } },
    { body: { status: 'completed', image: { url: 'https://cdn.example.com/out.png' } } },
  ]);
  let saved: any = null;
  const res = await presenter.generateSoulImage({
    keyId: 'k', keySecret: 's', fetchImpl: impl, wait: async () => {},
    input: presenter.presenterSceneRequest('https://media.example.com/p.jpg', 'p'),
    onSubmitted: (h: any) => { saved = h; },
  });
  assert.equal(res.imageUrl, 'https://cdn.example.com/out.png');
  assert.equal(res.requestId, 'req_1');
  assert.deepEqual(saved, { requestId: 'req_1', statusUrl: 'https://api.higgsfield.ai/requests/req_1' });
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('generateSoulImage with a saved handle polls it and never resubmits (no duplicate billing)', async () => {
  const { impl, calls } = mockFetchSequence([
    { body: { status: 'completed', image: { url: 'https://cdn.example.com/out.png' } } },
  ]);
  const res = await presenter.generateSoulImage({
    keyId: 'k', keySecret: 's', fetchImpl: impl, wait: async () => {},
    input: {}, resume: { requestId: 'req_9', statusUrl: 'https://api.higgsfield.ai/requests/req_9' },
  });
  assert.equal(res.requestId, 'req_9');
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
  assert.equal(calls.length, 1);
});

test('generateSoulImage rejects terminal provider failures and non-HTTPS results', async () => {
  const failed = mockFetchSequence([
    { body: { request_id: 'req_f', status_url: 'https://api.higgsfield.ai/requests/req_f' } },
    { body: { status: 'failed' } },
  ]);
  await assert.rejects(presenter.generateSoulImage({
    keyId: 'k', keySecret: 's', fetchImpl: failed.impl, wait: async () => {}, input: {},
  }), /failed.*Create a new job/i);

  const insecure = mockFetchSequence([
    { body: { request_id: 'req_i', status_url: 'https://api.higgsfield.ai/requests/req_i' } },
    { body: { status: 'completed', image: { url: 'http://not-https.example.com/x.png' } } },
  ]);
  await assert.rejects(presenter.generateSoulImage({
    keyId: 'k', keySecret: 's', fetchImpl: insecure.impl, wait: async () => {}, input: {},
  }), /HTTPS/);
});

// ── Compose mode wiring (filesystem only; no provider calls) ─────────

function makePlan() {
  return [
    { text: 'seg1', audioFile: 'audio/seg_01.mp3', avatarClip: 'avatar/seg_01.mp4', presenterAlpha: 'presenter/seg_01.webm', durationSec: 12.5 },
    { text: 'seg2', audioFile: 'audio/seg_02.mp3', avatarClip: 'avatar/seg_02.mp4', presenterAlpha: 'presenter/seg_02.webm', durationSec: 11.2 },
  ];
}

test('presenter composition keeps alpha clips on the narration clock and discloses AI', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ianews-presenter-'));
  const gallery = presenter.planPresenterShots(['photos/p1.jpg', 'photos/p2.jpg'], ['scenes/s1.png']);
  const { entryDir } = compose.generateRemotionProject({
    jobDir: tmp, plan: makePlan(), input: INPUT, fps: 30, gallery, mode: 'presenter',
  });
  const data = JSON.parse(fs.readFileSync(path.join(entryDir, 'segments.json'), 'utf-8'));
  assert.equal(data.mode, 'presenter');
  assert.match(data.disclosure, /généré par IA/i);
  assert.equal(data.segments.length, 2);
  assert.deepEqual(data.segments.map((s: any) => s.presenterAlpha), ['presenter/seg_01.webm','presenter/seg_02.webm']);
  assert.equal(data.segments[1].from, data.segments[0].duration);
  assert.ok(data.shots.every((s:any) => !s.presenter && !s.avatar && !s.video));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('generateRemotionProject defaults to panel mode with no disclosure and no presenter edits', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ianews-panel-'));
  const { entryDir } = compose.generateRemotionProject({
    jobDir: tmp, plan: makePlan(), input: INPUT, fps: 30,
    gallery: [{ photo: 'photos/p1.jpg' }, { photo: 'photos/p2.jpg' }],
  });
  const data = JSON.parse(fs.readFileSync(path.join(entryDir, 'segments.json'), 'utf-8'));
  assert.equal(data.mode, 'panel');
  assert.equal(data.disclosure, '');
  assert.ok(data.shots.every((s: any) => !s.presenter));
  assert.ok(data.shots.every((s: any) => !s.video));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Stage list wiring ────────────────────────────────────────────────

test('PROP_STAGES reflects lip-sync then local matte preparation', () => {
  const stages = pipeline.PROP_STAGES;
  const order = ['extract', 'script', 'voice', 'presenter', 'lipsync', 'scenePrep', 'motion', 'compose', 'render'];
  assert.deepEqual(stages, order);
});
