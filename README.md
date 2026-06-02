# iAnews - AI News Video Generator

## Setup

1. Copy `.env.example` to `.env` and add your OpenRouter API key:
   ```
   OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxx
   ```

2. Install dependencies:
   ```
   npm install
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
│   ├── orchestrator.ts  # Runs all agents sequentially
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
| `OPENROUTER_MODEL` | LLM model to use | `cognitivecomputations/dolphin-mixtral-8x7b:free` |
| `VIDEO_WIDTH` | Output width | `1280` |
| `VIDEO_HEIGHT` | Output height | `720` |
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
npx remotion render output/output.mp4
```
