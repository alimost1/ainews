import * as fs from 'fs';
import * as path from 'path';
/** Run once for the whole voice stage, not once per segment via a completed-stage guard. */
export async function prepareNarrationAudio(opts: {
  segments: {text: string; audioSec?: number}[];
  audioDir: string;
  generate: (text: string, file: string) => Promise<unknown>;
  probe: (file: string) => number;
  save: () => void;
}) {
  for (let i = 0; i < opts.segments.length; i++) {
    const file = path.join(opts.audioDir, `seg_${String(i + 1).padStart(2, '0')}.mp3`);
    if (!(fs.existsSync(file) && fs.statSync(file).size > 200)) await opts.generate(opts.segments[i].text, file);
    const seconds = opts.probe(file);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 15) {
      throw new Error(`Narration segment ${i + 1} must be between 0 and 15 seconds. Shorten the phrases and create a new job.`);
    }
    opts.segments[i].audioSec = seconds;
    opts.save();
  }
}
