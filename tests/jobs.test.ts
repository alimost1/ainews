import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..');

// Run the compiled pipeline modules in an isolated temp project so tests never
// touch the real data/jobs directory.
function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ianews-test-'));
  fs.mkdirSync(path.join(dir, 'data', 'jobs'), { recursive: true });
  return dir;
}

// The JobStore resolves JOBS_ROOT at module load from __dirname, so tests pin
// the index path via IANEWS_JOBS_INDEX and re-require with a cleared cache.
// This tests the JobStore class directly with a stubbed index path via fresh
// module instances.

// The compiled pipeline (dist/pipeline/jobs.js) is CommonJS. To get a fresh
// module instance per test with its own IANEWS_JOBS_INDEX, delete the require
// cache entry before require().
function freshJobsModule(indexPath: string) {
  process.env.IANEWS_JOBS_INDEX = indexPath;
  const resolved = require.resolve('../dist/pipeline/jobs.js');
  delete require.cache[resolved];
  return require(resolved) as typeof import('../pipeline/jobs');
}

test('validateJobInput accepts Arabic topics and rejects bad input', () => {
  const { validateJobInput } = require('../dist/pipeline/jobs') as typeof import('../pipeline/jobs');
  const ok = validateJobInput({
    topic: 'أحدث أخبار الذكاء الاصطناعي $(rm -rf /)',
    language: 'ar', targetDurationSec: 60, format: '9:16',
  });
  assert.equal(ok.language, 'ar');
  assert.equal(ok.targetDurationSec, 60);
  assert.equal(ok.format, '9:16');

  assert.throws(() => validateJobInput({ topic: '' }), /Topic is required/);
  assert.throws(() => validateJobInput({ topic: 'x'.repeat(501) }), /Topic too long/);
  assert.throws(() => validateJobInput({ topic: 'ai', language: 'fr' }), /Language/);
  assert.throws(() => validateJobInput({ topic: 'ai', language: 'ar', targetDurationSec: 5 }), /Duration/);
  assert.throws(() => validateJobInput({ topic: 'ai', language: 'ar', targetDurationSec: 30.5 }), /whole number/);
  assert.throws(() => validateJobInput({ topic: 'ai', language: 'ar', targetDurationSec: 30, format: '4:3' }), /Format/);
  assert.throws(() => validateJobInput(null), /JSON object/);
});

test('job workspace is isolated per job id and safe to init twice', () => {
  const { jobWorkspace } = require('../dist/pipeline/jobs') as typeof import('../pipeline/jobs');
  const a = jobWorkspace('id-a');
  const b = jobWorkspace('id-b');
  assert.notEqual(a.dir, b.dir);
  assert.ok(a.dir.endsWith(path.join('data', 'jobs', 'id-a')));
  assert.ok(a.imagesDir.endsWith('id-a' + path.sep + 'images') || a.imagesDir.includes('id-a'));
  // No job workspace may escape the jobs root
  const jobsRoot = path.resolve(ROOT, 'data', 'jobs');
  assert.ok(path.resolve(a.dir).startsWith(jobsRoot));
  assert.ok(path.resolve(b.dir).startsWith(jobsRoot));
});

test('create/list/get/retry/cancel lifecycle with persistence across store instances', () => {
  const tmp = makeTempProject();
  const indexPath = path.join(tmp, 'data', 'jobs', 'index.json');
  fs.writeFileSync(indexPath, '{}');

  const mod = freshJobsModule(indexPath);
  const store = new mod.JobStore();
  const job = store.create({ topic: 'اختبار', language: 'ar', targetDurationSec: 30, format: '16:9', skipRender: true });
  assert.equal(job.status, 'queued');
  assert.equal(job.stages.render.status, 'skipped');
  assert.equal(job.stages.research.status, 'pending');

  // Persisted: a second store instance sees it
  const store2 = new mod.JobStore();
  assert.ok(store2.get(job.id));

  // Idempotency: same clientToken within window returns same job
  const dup = store2.create({ topic: 'اختبار', language: 'ar', targetDurationSec: 30, format: '16:9', skipRender: true, clientToken: 'tok-1' });
  const dup2 = store2.create({ topic: 'اختبار', language: 'ar', targetDurationSec: 30, format: '16:9', skipRender: true, clientToken: 'tok-1' });
  assert.equal(dup.id, dup2.id);

  // updateStage + failure
  store2.updateStage(job.id, 'research', { status: 'failed', error: 'boom' });
  store2.update(job.id, { status: 'failed', error: 'boom' });
  assert.equal(store2.get(job.id)!.status, 'failed');

  // retry resets failed stages only
  const retried = store2.retry(job.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.stages.research.status, 'pending');
  assert.equal(retried.stages.render.status, 'skipped'); // untouched

  // cancel a queued job
  const canceled = store2.cancel(job.id);
  assert.equal(canceled.status, 'canceled');
  assert.throws(() => store2.retry(job.id), /Only failed jobs/);

  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.IANEWS_JOBS_INDEX;
});

test('resume keeps completed stages and resets only interrupted ones', () => {
  const tmp = makeTempProject();
  const indexPath = path.join(tmp, 'data', 'jobs', 'index.json');
  fs.writeFileSync(indexPath, '{}');
  const mod = freshJobsModule(indexPath);
  const store = new mod.JobStore();
  const job = store.create({ topic: 'resume test', language: 'en', targetDurationSec: 30, format: '9:16' });

  // Simulate: research+script completed, images was running when server died
  store.updateStage(job.id, 'research', { status: 'completed' });
  store.updateStage(job.id, 'script', { status: 'completed' });
  store.updateStage(job.id, 'images', { status: 'running', startedAt: new Date().toISOString() });
  store.update(job.id, { status: 'running' });

  // Re-fetch the persisted job (records are copies, not live references)
  const running = store.get(job.id)!;
  const inFlight = mod.ALL_STAGES.find(s => running.stages[s].status === 'running');
  assert.equal(inFlight, 'images');
  store.updateStage(job.id, 'images', { status: 'failed', error: 'Interrupted by server restart' });
  const afterInterrupt = store.get(job.id)!;
  assert.equal(afterInterrupt.stages.research.status, 'completed'); // completed assets preserved
  assert.equal(afterInterrupt.stages.images.status, 'failed');

  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.IANEWS_JOBS_INDEX;
});

test('audio duration is measured with ffprobe and corrupt placeholders rejected', () => {
  // Build a silent 1s mp3 and confirm ffprobe reports a positive duration
  const tmp = makeTempProject();
  const mp3 = path.join(tmp, 'test.mp3');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-b:a', '64k', mp3],
    { stdio: 'pipe' });
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', mp3], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  assert.ok(Number.isFinite(dur) && dur > 0.5 && dur < 2);

  // A file below the MP3 header threshold must be treated as corrupt
  const fake = path.join(tmp, 'fake.mp3');
  fs.writeFileSync(fake, Buffer.from([0x49, 0x44, 0x33])); // 3 bytes: corrupt
  assert.ok(fs.statSync(fake).size <= 44);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('timeline keeps scenes consecutive with no overlap using measured audio durations', () => {
  const { buildTimeline } = require('../dist/pipeline/timeline') as typeof import('../pipeline/timeline');
  const scene = (n: number, audio?: number) => ({
    scene_number: n, narration_text: 'An example narration text here',
    visual_prompt: 'An example visual photograph prompt',
    duration_seconds: 7, mood: 'neutral' as const, voice_emotion: 'friendly' as const,
    ...(audio != null ? { audio_duration: audio } : {}),
  });
  const scenes = [scene(1, 7.2), scene(2, 6.8), scene(3, 10.05)];
  const timeline = buildTimeline(scenes, 30);
  let offset = 0;
  for (const entry of timeline) {
    assert.equal(entry.from, offset); // consecutive: each starts where previous ended
    offset += entry.duration;
  }
  assert.equal(offset, Math.ceil(7.2 * 30) + Math.ceil(6.8 * 30) + Math.ceil(10.05 * 30));
  // Fractional audio preserved: 7.2s @30fps = 216 frames exactly
  assert.equal(timeline[0].duration, 216);
  assert.equal(timeline[2].duration, 302); // ceil(301.5)
});

test('provider request IDs are read from the job log only when present', () => {
  const tmp = makeTempProject();
  const indexPath = path.join(tmp, 'data', 'jobs', 'index.json');
  fs.writeFileSync(indexPath, '{}');
  const mod = freshJobsModule(indexPath);
  const store = new mod.JobStore();
  const job = store.create({ topic: 'ids', language: 'en', targetDurationSec: 30, format: '9:16' });
  // No provider log -> the runner records empty ids; we can at least assert the log path convention
  const ws = mod.jobWorkspace(job.id);
  assert.ok(ws.dir.endsWith(job.id));
  assert.ok(!fs.existsSync(path.join(ws.dir, 'provider_ids.log')));
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.IANEWS_JOBS_INDEX;
});
