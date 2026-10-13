export function parseOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const separator = arg.indexOf('=');
    const key = arg.slice(2, separator === -1 ? undefined : separator);
    if (!key) throw new Error('Option name cannot be empty');
    if (separator !== -1) options[key] = arg.slice(separator + 1);
    else if (args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else options[key] = 'true';
  }
  return options;
}

export function pipelineOptions(args: string[], defaultDuration = 30) {
  const parsed = parseOptions(args);
  for (const key of Object.keys(parsed)) {
    if (!['topic', 'duration', 'skip-render'].includes(key)) throw new Error(`Unknown option: --${key}`);
  }
  const topic = (parsed.topic ?? 'Latest AI breakthroughs and news').trim();
  if (!topic) throw new Error('Topic cannot be empty');
  const duration = Number(parsed.duration ?? defaultDuration);
  if (!Number.isInteger(duration) || duration < 9 || duration > 300) {
    throw new Error('Duration must be a whole number between 9 and 300 seconds');
  }
  if (parsed['skip-render'] !== undefined && !['true', 'false'].includes(parsed['skip-render'])) {
    throw new Error('--skip-render must be true or false');
  }
  return { topic, duration, skipRender: parsed['skip-render'] === 'true' };
}
