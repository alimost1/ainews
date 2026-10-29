/** Local chroma-key preparation. Never substitutes a still for a speaking clip. */
import { execFileSync, execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
import * as path from 'path';
export function matteArgs(input: string, output: string, duration: number): string[] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 15) throw new Error('Invalid presenter duration');
  return ['-v','error','-y','-i',input,'-an','-vf',
    'setpts=PTS-STARTPTS,fps=30,scale=540:-2,format=rgba,colorkey=0x007000:0.5:0.4,despill=type=green:alpha=1,format=yuva420p',
    '-t',String(duration),'-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0','-crf','24','-b:v','0','-deadline','good','-cpu-used','4',output];
}
/** Verify the actual decoded alpha, not just WebM metadata (which may lie). */
export function alphaCoverage(file: string, atSec = 0): { transparent: number; opaque: number } {
  const bytes = execFileSync('ffmpeg',['-v','error','-c:v','libvpx-vp9','-i',file,'-ss',String(atSec),'-frames:v','1','-vf','format=yuva420p,alphaextract,scale=64:64','-f','rawvideo','-pix_fmt','gray','pipe:1'],{timeout:30000});
  let transparent=0,opaque=0;
  if (!bytes.length) throw new Error('Decoded presenter alpha is empty');
  for(const value of bytes) { if(value<32) transparent++; if(value>224) opaque++; }
  return {transparent:transparent/bytes.length,opaque:opaque/bytes.length};
}
export async function prepareTransparentPresenter(input: string, output: string, duration: number): Promise<void> {
  fs.mkdirSync(path.dirname(output),{recursive:true});
  const tmp=output.replace(/\.webm$/,'.tmp.webm');
  try {
    await execFileAsync('ffmpeg',matteArgs(input,tmp,duration),{timeout:300000});
    for (const at of [0, duration * .5, Math.max(0, duration - .1)]) {
      const coverage=alphaCoverage(tmp, at);
      if(coverage.transparent<.05 || coverage.opaque<.02) throw new Error('Presenter background removal failed. Use a uniform green-screen portrait and regenerate lip-sync; no opaque fallback was rendered.');
    }
    fs.renameSync(tmp,output);
  } finally {fs.rmSync(tmp,{force:true});}
}
