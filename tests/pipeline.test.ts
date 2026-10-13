import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipelineOptions } from '../src/pipeline/options';
import { buildTimeline } from '../src/pipeline/timeline';
import type { Scene } from '../src/types';

const scene = (id: number, audio?: number): Scene => ({
  scene_number: id, narration_text: 'An example narration', visual_prompt: 'An example photograph',
  duration_seconds: 7, audio_duration: audio, mood: 'neutral', voice_emotion: 'friendly',
});

test('documented equals syntax and separated CLI options agree', () => {
  const expected = { topic: 'AI breakthroughs', duration: 120, skipRender: true };
  assert.deepEqual(pipelineOptions(['--topic=AI breakthroughs', '--duration=120', '--skip-render']), expected);
  assert.deepEqual(pipelineOptions(['--topic', 'AI breakthroughs', '--duration', '120', '--skip-render', 'true']), expected);
  assert.equal(pipelineOptions(['--skip-render=false']).skipRender, false);
});

test('topics preserve quotes, Arabic and shell characters as plain data', () => {
  const topic = 'أخبار "AI" $(echo unsafe)';
  assert.equal(pipelineOptions(['--topic', topic]).topic, topic);
});

test('invalid options fail before generation begins', () => {
  for (const duration of ['0', '-1', 'abc', '30seconds', '1.5', '301', '']) {
    assert.throws(() => pipelineOptions([`--duration=${duration}`]), /Duration/);
  }
  assert.throws(() => pipelineOptions(['--skip-render=maybe']), /skip-render/);
  assert.throws(() => pipelineOptions(['--duraton=30']), /Unknown/);
  assert.throws(() => pipelineOptions(['--topic=']), /Topic/);
});

test('timeline places scenes consecutively and keeps fractional narration intact', () => {
  const timeline = buildTimeline([scene(1, 8.015), scene(2, 4.125), scene(3)], 30);
  assert.deepEqual(timeline.map(({from, duration}) => ({from, duration})), [
    {from: 0, duration: 241}, {from: 241, duration: 124}, {from: 365, duration: 210},
  ]);
});

test('invalid timelines never produce empty or invalid Remotion sequences', () => {
  assert.throws(() => buildTimeline([], 30), /at least one/);
  assert.throws(() => buildTimeline([scene(1)], 0), /FPS/);
  for (const duration of [0, -1, NaN, Infinity]) {
    assert.throws(() => buildTimeline([scene(1, duration)], 30), /Invalid duration/);
  }
});
