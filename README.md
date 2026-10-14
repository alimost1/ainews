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

## Generation Dashboard

A web dashboard for daily video production runs at **`/dashboard`** on the server.

```bash
# Build the dashboard + pipeline once
npm run build:dashboard

# Start the server (dashboard + Facebook/YouTube publishing)
npm run start:server
# → http://localhost:8090/dashboard
```

Features:
- Arabic/English topics with RTL Arabic UI
- Language, target duration (9–300s) and format (9:16 / 16:9 / 1:1) selection
- Live per-stage progress (research → script → images → voice → edit → render)
- Duplicate-submission prevention (button lock + clientToken idempotency)
- Failure messages with one-click retry; cancel while queued/running
- Completed video preview and download; generation history with status and dates
- Target duration shown separately from the actual rendered duration

### Job management

Every generation is a job with a unique ID and an **isolated workspace** at
`data/jobs/<id>/` — its own `script.json`, `images/`, `audio/`, and render
assets. Concurrent jobs can never overwrite each other's files.

- Jobs persist in `data/jobs/index.json` (atomic writes) and **survive server
  restarts**: interrupted stages are marked failed and the job is requeued;
  completed stages and their assets are reused on retry.
- A bounded queue (default concurrency 1, `IANEWS_QUEUE_CONCURRENCY`) matches
  the heavy image/TTS/render stages.
- Each stage subprocess has a hard timeout (`IANEWS_STAGE_TIMEOUT_MS`).
- Real provider request IDs (OpenRouter) are recorded per stage; none are invented.

### Dashboard API

| Method | Path | Description |
|---|---|---|
| POST | `/api/jobs` | Create a generation job (validated, idempotent via `clientToken`) |
| GET | `/api/jobs` | Job history |
| GET | `/api/jobs/:id` | Job detail with stage statuses |
| POST | `/api/jobs/:id/retry` | Retry failed stages (keeps completed assets) |
| POST | `/api/jobs/:id/cancel` | Cancel a queued/running job |
| GET | `/api/jobs/:id/video` | Download the completed MP4 |
| GET | `/api/config` | Supported providers, models, and limits |
| GET | `/api/queue` | Queue stats |

### Security notes

- All Facebook/Google OAuth token exchanges use the `https` module with
  URL-encoded parameters — no shell interpolation of credentials.
- Facebook OAuth validates a signed `state` cookie (CSRF protection).
- Request bodies are size-limited (32 KB) and validated before job creation.
- Video downloads are restricted to the job's own output directory.
- `PUBLIC_BASE_URL` replaces the previously hardcoded deployment domain; OAuth
  redirects derive from it.

## Property URL → Avatar Presentation Video

Turn any property listing URL into a vertical (1080×1920) presentation video
with a talking avatar and the listing's real photos.

```bash
npm run build:dashboard
npm run start:server
# → http://localhost:8090/property
```

### Flow
1. **Paste a listing URL** — the server fetches it (SSRF-guarded: private
   networks, localhost, and cloud metadata endpoints are refused, including
   after redirects) and extracts: title, reference, location, price/currency,
   land area, built area, bedrooms, bathrooms, description, amenities, and
   gallery images (relative + lazy-loaded URLs resolved; logos/icons/ads and
   duplicate images excluded).
2. **Review and edit** — every field is editable; photos are selectable and
   re-orderable; a narration is proposed from the reviewed facts and can be
   edited freely. The source agency is kept as the branding default — never
   replaced. Built area is never inferred from land area.
3. **Generate** — with explicit confirmation showing the provider, model,
   voice, estimated narration duration, and billable motion seconds. Provider prices depend on the model and account.
4. **Preview and download** the MP4; history lists every job with per-stage status.

### Video structure (fr default, ar + en supported)
Opening (avatar introduces the property) → tour (real photos, Ken Burns pan/zoom,
crossfades) → highlight captions (verified facts, price, location; RTL for Arabic)
→ closing invitation to contact the agency. The avatar stays in a small panel,
never composited into the property, and photos are used as-is (watermarks intact).

### Lip-sync capability (verified)
The avatar stage uses **Higgsfield `wan/v2.7/image-to-video`** with
`image_url` + `audio_url` + prompt + duration (2–15 s per segment) +
`resolution: 1080p` — the audio-driven image-to-video
endpoint documented at docs.higgsfield.ai. Narration is split into ≤14 s
segments; each segment is lipsynced separately with the real provider
`request_id` polled to completion, then all segments are assembled
consecutively (ffprobe-measured audio durations — no overlap, no cut-offs)
into a Remotion composition.

If `HF_API_KEY_ID`/`HF_API_KEY_SECRET` or `ELEVENLABS_API_KEY` are missing,
the job fails immediately with the exact missing variables named — no silent
substitution and no invented models.

### API
| Method | Path | Description |
|---|---|---|
| POST | `/api/property/extract` | `{url}` → extracted listing |
| POST | `/api/property/jobs` | Create draft (validated; clientToken idempotent) |
| POST | `/api/property/jobs/:id/generate` | Queue generation after review |
| POST | `/api/property/jobs/:id/cancel` | Cancel queued/running job |
| GET | `/api/property/jobs` | History with stage statuses |
| GET | `/api/property/jobs/:id/video` | Download the MP4 (path-restricted) |
| POST | `/api/property/upload-avatar` | Upload presenter portrait (PNG/JPG ≤ 2 MB) |
| GET | `/api/property/config` | Verified capabilities + pricing guidance |

Each job gets its own workspace `data/prop-jobs/<id>/` (listing, narration
audio, avatar clips, generated Remotion project, MP4). Jobs persist across
restarts; completed assets are reused on retry. API keys never leave the
backend. Nothing is published automatically.


### Cinematic property videos

The property flow builds on Hermes's `feature/property-avatar-presentation` branch.
At `/property`, paste the listing URL, review facts and narration, select photos in
presentation order, upload a presenter portrait, and choose photo motion:

| Mode | Implementation | Additional generated property clips |
|---|---|---|
| Dynamic photos (default) | Original photos, alternating pan/zoom, 0.4s crossfades | None |
| Kling 3.0 Pro | `kling-video/v3.0/pro/image-to-video`, sound off | 5s per selected photo |
| Wan 3.0 | `alibaba/wan-3.0/image-to-video`, 1080p, sound off | 5s per selected photo |

The edit changes photos around every four seconds, independently of narration
segments, and uses every selected photo. It includes animated opening typography,
reviewed highlights, price, source agency, contact ending, a progress line, and a
presenter panel that leaves most of the image visible. Photos fit without stretching
against a blurred backdrop. Spoken audio remains continuous while pictures crossfade.

The avatar stays on the documented audio-driven Wan 2.7 endpoint at 1080p; motion
models are not treated as interchangeable lip-sync providers. Official schemas:
- https://open.higgsfield.ai/models/kling-video/v3.0/pro/image-to-video/api-reference
- https://open.higgsfield.ai/models/alibaba/wan-3.0/image-to-video/api-reference
- https://open.higgsfield.ai/models/wan/v2.7/image-to-video/api-reference

Schemas were checked on 2026-10-14. Model access and prices depend on your account.
AI prompts request conservative camera movement and unchanged architecture, but
model output can still alter details: inspect generated clips before using them
in an advertisement. Choose dynamic photos when exact source imagery matters.
The paid generation confirmation shows the selected model, photo count and
billable motion seconds; no unsupported fixed price is quoted.

Set `PUBLIC_BASE_URL` to this server's externally reachable HTTPS base URL so
Higgsfield can fetch the portrait, narration, and selected gallery photos. Set
`HF_API_KEY_ID`, `HF_API_KEY_SECRET`, and `ELEVENLABS_API_KEY` server-side.
The server now resolves its project directory from its own location; optionally
set `IANEWS_PROJECT_ROOT` if media lives elsewhere.

```sh
npm ci
npm run build:dashboard
npm run start:server
```

Open `/property` on that server. New provider request handles are saved before
polling, so a retry reuses an in-flight request instead of billing a new POST.
Provider-terminal failures require a new job. Do not retry an ambiguous failed
submission until provider billing confirms whether it was accepted.

Validation: `npm run typecheck`, `npm run build:dashboard`, and `npm test`.
Automated tests use mocked providers and do not spend API credits.
