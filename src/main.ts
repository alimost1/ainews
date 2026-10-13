/** Runs the video pipeline with persisted progress and fail-fast stages. */
import { execFileSync } from 'child_process';
import * as path from 'path';
import { CONFIG, logger, writeJSON } from './agents/shared';
import { pipelineOptions } from './pipeline/options';

export async function main() {
  const { topic, duration, skipRender } = pipelineOptions(process.argv.slice(2), CONFIG.duration);
  if (!CONFIG.openRouterApiKey) throw new Error('Set OPENROUTER_API_KEY before starting the pipeline');
  const startedAt = new Date().toISOString();
  const statusPath = path.join(CONFIG.dataDir, 'pipeline_status.json');
  const stages = [
    { name: 'research', args: ['tsx', 'src/agents/Director.ts', '--topic', topic, '--duration', String(duration)] },
    { name: 'script', args: ['tsx', 'src/agents/ScriptWriter.ts', '--topic', topic] },
    // Both agents update script.json, so keep these stages sequential.
    { name: 'images', args: ['tsx', 'src/agents/VisualArtist.ts'] },
    { name: 'voice', args: ['tsx', 'src/agents/VoiceDirector.ts'] },
    { name: 'edit', args: ['tsx', 'src/agents/Editor.ts'] },
    ...(!skipRender ? [{ name: 'render', args: ['remotion', 'render', 'src/index.ts', 'VideoComposition', 'output/output.mp4'] }] : []),
  ];
  const completedStages: string[] = [];
  let stage = stages[0].name;
  const persist = (status: string, extra: Record<string, unknown> = {}) => writeJSON(statusPath, {
    status, stage, topic, duration, startedAt, updatedAt: new Date().toISOString(),
    completedStages, totalStages: stages.length, ...extra,
  });
  try {
    for (const step of stages) {
      stage = step.name;
      persist('running');
      logger.info(`Step ${completedStages.length + 1}/${stages.length}: ${stage}`);
      execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', step.args, {
        cwd: CONFIG.projectRoot, stdio: 'inherit', timeout: 900000,
        env: { ...process.env, VIDEO_DURATION: String(duration) },
      });
      completedStages.push(stage);
      persist('running');
    }
    const output = skipRender ? null : path.join(CONFIG.outputDir, 'output.mp4');
    persist('completed', { output, finishedAt: new Date().toISOString() });
    logger.success(output ? `Video ready: ${output}` : 'Assets ready. Rendering was skipped.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    persist('failed', { error: message, finishedAt: new Date().toISOString() });
    throw error;
  }
}

if (require.main === module) main().catch(error => {
  logger.error(error.message);
  process.exitCode = 1;
});
