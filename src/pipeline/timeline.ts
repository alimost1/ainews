import type { Scene } from '../types';

export function buildTimeline(scenes: Scene[], fps: number) {
  if (!Number.isInteger(fps) || fps <= 0) throw new Error('FPS must be a positive integer');
  if (!scenes.length) throw new Error('Script must contain at least one scene');
  let offset = 0;
  return scenes.map(scene => {
    const seconds = scene.audio_duration ?? scene.duration_seconds;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Invalid duration for scene ${scene.scene_number}`);
    const duration = Math.max(1, Math.ceil(seconds * fps));
    const entry = { scene, from: offset, duration };
    offset += duration;
    return entry;
  });
}
