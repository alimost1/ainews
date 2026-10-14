import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VideoComposition } from '../src/components/VideoComposition';
import { Sequence } from 'remotion';
import { generateVideoComposition } from '../src/agents/Editor';
import ts from 'typescript';
import type { Script } from '../src/types';

test('existing composition sequences all four scenes without overlap', () => {
  const root = VideoComposition({}) as any;
  const sequences = root.props.children;
  assert.deepEqual(sequences.map((s: any) => s.props.from), [0, 240, 480, 690]);
  assert.ok(sequences.every((s: any) => s.type === Sequence));
});

test('editor output schedules measured audio and escapes topic/narration in source', () => {
  const script: Script = {
    topic: 'أخبار */\n "AI"', total_duration: 14, generated_at: new Date().toISOString(), research_summary: 'Example',
    scenes: [1, 2].map(scene_number => ({
      scene_number, narration_text: 'Arabic أخبار "quoted" narration', visual_prompt: 'Example visual photograph',
      duration_seconds: 7, audio_duration: 7.015, mood: 'neutral', voice_emotion: 'friendly',
    })),
  };
  const source = generateVideoComposition(script);
  assert.match(source, /from: 0, duration: 211/);
  assert.match(source, /from: 211, duration: 211/);
  assert.match(source, /durationInFrames=\{422\}/);
  assert.match(source, /<Sequence key=\{key\} from=\{scene.from\}/);
  const compiled = ts.transpileModule(source, { fileName: 'VideoComposition.tsx', reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } });
  assert.deepEqual(compiled.diagnostics, []);
});
