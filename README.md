# iAnews - AI News Video Generator

## Setup

1. Copy `.env.example` to `.env` and add your OpenRouter API key:
   ```
   OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxx
   ```

2. Install Node.js 20 or newer, Python `edge-tts` (`pip install edge-tts`), and FFmpeg (including `ffprobe`). Then install dependencies:
   ```
   npm ci
   ```

3. Run the full pipeline:
   ```
   npm start -- --topic="Latest AI breakthroughs" --duration=120
   ```

4. Or step by step:
   ```
   npm run director -- --topic="AI news" --duration=120
   npm run script
   npm run visuals
   npm run voice
   npm run editor
   npm run render
   ```

## Project Structure

```
ianews/
├── src/
│   ├── agents/          # All AI agents
│   │   ├── Director.ts      # Fetches & summarizes news
│   │   ├── ScriptWriter.ts  # Generates video script
│   │   ├── VisualArtist.ts  # Generates scene images
│   │   ├── VoiceDirector.ts # Generates TTS audio
│   │   ├── Editor.ts        # Generates Remotion composition
│   │   └── shared.ts        # Shared utilities & API helpers
│   ├── components/      # Remotion React components
│   │   └── Scene.tsx        # Individual scene component
│   ├── types/           # TypeScript type definitions
│   │   └── index.ts
│   ├── main.ts  # Runs all agents sequentially
│   └── index.ts         # Remotion entry point
├── data/                # Generated script.json
├── public/
│   ├── images/          # Generated scene images
│   └── audio/           # Generated scene audio
├── output/              # Final rendered video
├── .env                 # OpenRouter API key
├── remotion.config.ts   # Remotion configuration
└── package.json
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENROUTER_API_KEY` | OpenRouter API key (required) | - |
| `OPENROUTER_MODEL` | LLM model to use | `openai/gpt-oss-120b:free` |
| `VIDEO_WIDTH` | Output width | `1080` |
| `VIDEO_HEIGHT` | Output height | `1920` |
| `FPS` | Frames per second | `30` |

## Agents

### Director Agent
- Fetches latest AI news from arXiv, HuggingFace, GitHub Trending
- Summarizes research using OpenRouter LLM
- Outputs structured JSON plan

### ScriptWriter Agent
- Transforms research into video scenes
- Each scene has: narration, visual prompt, duration, mood, voice emotion

### VisualArtist Agent
- Generates images for each scene via Pollinations.ai
- Saves to `public/images/scene_{i}.jpg`

### VoiceDirector Agent
- Generates TTS audio for each scene via edge-tts
- Voice selection based on mood
- Saves to `public/audio/scene_{i}.mp3`

### Editor Agent
- Generates the Remotion `VideoComposition.tsx`
- Syncs audio + images per scene
- Handles transitions and total duration

## Rendering

The final video is rendered to `output/output.mp4` using:
```
npm run render
```

## Reliable generation and progress

Options accept both `--topic="AI news"` and `--topic "AI news"`. Duration is
9–300 whole seconds and is passed to both research and script generation.
The default is `VIDEO_DURATION` (30 seconds when unset). For asset generation only:

```sh
npm start -- --topic="أخبار الذكاء الاصطناعي" --duration=30 --skip-render
```

`data/pipeline_status.json` records the current stage (`research`, `script`,
`images`, `voice`, `edit`, `render`), completed stages, timestamps, and any failure.
Check it while the command runs to see progress. Run only one pipeline at a time:
image and voice stages share `data/script.json` and run sequentially.

Narration failures stop the pipeline rather than producing placeholder audio.
Audio duration is measured with `ffprobe`, and scenes play consecutively without
cutting off fractional seconds of narration. Editing refuses missing images or
missing/placeholder audio before writing the Remotion composition.
The requested duration is a script target; final video length follows the actual
narration duration. Generation does not publish to social platforms.

## Development checks

```sh
npm run typecheck
npm test
```

Tests cover command parsing, Arabic/quoted topics, invalid options, scene timing,
and generated composition behavior without calling paid generation services.
