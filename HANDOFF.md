# HeyGen × HyperFrames Outbound — Handoff

**Read this first if you're picking up the project in a new thread.**

---

## What this is

A hackathon project for the HeyGen WTD hackathon (May 2026): drop in a LinkedIn URL or company name, and the system generates a personalized 30-second outbound video by combining HeyGen Avatar V (talking head) with HyperFrames (overlay graphics) using ElevenLabs Scribe for word-level timing.

- **Live URL:** https://heygen-hyperframes-outbound.vercel.app
- **Repo:** `/Users/arindam/Documents/Projects/heygen-hyperframes-outbound/` (git, `main` branch)
- **Plan:** Vercel Hobby (300s function timeout cap, 5h Sandbox CPU/month allowance)
- **Brand:** AIforOperations (white "AI" + red "for Operations" wordmark; `#DC2626` lead, `#F87171` light)

## The pipeline that works end-to-end

```
[ user input: avatarId + script ]
        │
        ▼
POST /api/test/generate-video  (Node, 300s max)
   1. Validate engine vs supported_api_engines on the avatar
   2. Resolve voice — avatar's HeyGen default_voice_id
   3. createVideo() → HeyGen v3 /v3/videos (engine: avatar_v|iv)
   4. Poll /v3/videos/{id} every 10s until completed
   5. Download MP4 + ffmpeg extract audio
   6. ElevenLabs Scribe v1 transcribe → word_timestamps
   7. Auto-save MP4 + JSON sidecar to /video/
        │
        ▼
[ video/<timestamped>.mp4 + .json sidecar (avatarId, voice, transcript, word timing) ]
        │
        ▼
scripts/build-composition.mjs
   - reads sidecar
   - resolves per-avatar crop hints from src/lib/avatars.ts
   - copies MP4 into public/compositions/<name>/assets/avatar.mp4
   - generates index.html (614px circle + warm cream brand + 3 title cards)
        │
        ▼
POST /api/render  (Vercel Sandbox)
   - Snapshot restore: ~350ms (or full setup ~20s cold)
   - sandbox.writeFiles(composition)
   - `npx hyperframes render composition -o out.mp4 --workers auto`
   - sandbox.readFileToBuffer("out.mp4")
   - @vercel/blob put() → public URL
```

Render times (verified):
- HeyGen Avatar V: ~115–145s
- HeyGen Avatar IV: ~68s (much faster, less expensive)
- HyperFrames overlay render: ~13–18s

## File map

| File | What it does |
|---|---|
| `src/lib/env.ts` | Typed server-only env access, lazy-throw on missing required keys |
| `src/lib/heygen.ts` | HeyGen v3 client — listAvatarLooks, getAvatarLook, listVoices, generateSpeech, uploadAudioAsset, createVideo, getVideo, pollVideo |
| `src/lib/elevenlabs.ts` | Scribe v1 STT client → returns `words: [{ text, start, end, type }]` |
| `src/lib/audio.ts` | `extractAudioFromVideoUrl()` — downloads MP4, runs ffmpeg, returns MP3 Buffer |
| `src/lib/avatars.ts` | **The 7 curated avatars + per-avatar crop hints.** Single source of truth. |
| `src/lib/sandbox.ts` | Vercel Sandbox orchestrator — restoreOrCreate, prepareSandbox, renderInSandbox |
| `src/lib/composition-files.ts` | Walks a composition folder into `[{ path, content }]` for Sandbox |
| `src/app/api/heygen/ping/route.ts` | `GET` — smoke test: lists avatar_v eligible looks + Starfish voices |
| `src/app/api/avatars/route.ts` | `GET` — returns 7 curated avatars with fresh preview URLs |
| `src/app/api/test/generate-video/route.ts` | `POST` — full HeyGen → ElevenLabs flow (synchronous, 300s cap) |
| `src/app/api/render/route.ts` | `POST` — renders a composition folder via Vercel Sandbox |
| `src/app/page.tsx` | Single client component frontend (hero, builder, mock pipeline, gallery) |
| `scripts/build-composition.mjs` | Takes `<sidecar.json> <comp-dir>` → writes index.html with crop hints inlined |
| `scripts/create-snapshot.mjs` | Runs at `npm run build` on Vercel → creates Sandbox snapshot, stores pointer in Blob |
| `public/compositions/demo-01/` | Reference composition (Tony, old video) |
| `public/compositions/annie-demo/` | Reference composition (Annie, validates new crop) |
| `video/` | All renders auto-saved here. MP4s gitignored, JSON sidecars committed for history |

## The 7 curated avatars (with crop hints)

| Avatar ID | Label | Type | scale | originY | positionY |
|---|---|---|---|---|---|
| `c3df4083b7dd49ba9c34bd0d43738a4c` | Ari | digital_twin (portrait) | 1.00 | 30% | 22% |
| `Annie_Desk_Sitting_Front_2_public` | Annie | studio sitting | 1.25 | 30% | 30% |
| `Brandon_Office_Sitting_Front_public` | Brandon | studio sitting | 1.25 | 28% | 30% |
| `Masha_sitting_office_front` | Masha | studio sitting | 1.20 | 30% | 30% |
| `Leos_sitting_office_front` | Leos | studio sitting | 1.15 | 30% | 30% |
| `Joel_standing_mountain_front` | Joel | studio standing | 1.45 | 25% | 30% |
| `Leszek_standing_outdoorbusiness_front` | Leszek | studio standing | 1.40 | 28% | 30% |

All seven support `avatar_v` + `avatar_iv`. Voice = each avatar's HeyGen `default_voice_id` (not Starfish — STT happens post-render).

## Credentials (already in `.env.local` + Vercel prod)

```
HEYGEN_API_KEY        — required; verified working
ANTHROPIC_API_KEY     — set, NOT YET USED (script generation is the next feature)
ELEVENLABS_API_KEY    — required; verified working
APIFY_TOKEN           — set, NOT YET USED (LinkedIn scraping)
SERPAPI_KEY           — set, NOT YET USED
BLOB_READ_WRITE_TOKEN — auto from Blob store linked to project
VERCEL_OIDC_TOKEN     — auto via `vercel env pull`; for Sandbox auth in dev
```

If `.env.local` is missing on a fresh machine: `vercel env pull .env.local` then merge in HEYGEN/ANTHROPIC/ELEVENLABS keys from `/Users/arindam/Documents/Claude/api_keys.md`.

## How to verify everything in <60 seconds

```bash
cd /Users/arindam/Documents/Projects/heygen-hyperframes-outbound
PORT=3030 npm run dev &
sleep 5

# 1. Avatars endpoint should return 7
curl -s http://localhost:3030/api/avatars | python3 -c "import json,sys;print('avatars:',len(json.load(sys.stdin)['avatars']))"

# 2. HeyGen ping should report eligible counts
curl -s http://localhost:3030/api/heygen/ping | head -c 300

# 3. Production should be live
curl -sI https://heygen-hyperframes-outbound.vercel.app/ | head -1
```

## What's DONE (don't redo)

- HeyGen v3 client with engine validation (IV/V)
- ElevenLabs Scribe transcription
- ffmpeg audio extraction
- HyperFrames composition build script with per-avatar crop CSS variables
- Vercel Sandbox rendering pipeline (with snapshot caching)
- Vercel Blob output storage
- Frontend hero/builder/mock-pipeline/gallery
- Geist + Geist Mono typography
- Dark mode with warm-cream HyperFrames composition palette
- 7 curated avatars + crop hints
- All bug fixes from the polish pass (avatar dropdown click-outside, ⌘+Enter, char counter, a11y, disabled tooltip)

## What's NOT done (open work)

In priority order:

1. **Anthropic script generation** — `POST /api/script` takes `{ prospect, prompt }` → returns 30s script + beat structure. ANTHROPIC_API_KEY is set; no code yet. Use Claude API skill (claude-opus-4-7 with adaptive thinking).
2. **Wire frontend Generate button to the real backend** — currently runs a mock pipeline animation. Replace `startGeneration()` in `page.tsx` to call `POST /api/test/generate-video` and stream stage updates.
3. **LinkedIn / company scraper** — `POST /api/scrape`. Apify token is set. Define output schema: `{ name, role, company, stat }`.
4. **Orchestrator** — `POST /api/generate` that runs scrape → script → HeyGen → HyperFrames. Needs job-state persistence (Vercel KV / Upstash) because HeyGen render alone exceeds 300s. HeyGen webhooks recommended over polling.
5. **Gallery cards point to real prerendered videos** — currently mock buttons with no `<video src>`.
6. **Engine toggle on frontend** — state exists; needs to flow into the backend POST when frontend wires to real backend.
7. **Email capture backend** — currently just `localStorage`. Replace with a real endpoint (could be a Vercel function writing to KV or directly to a Google Sheet).

## Conventions and decisions (don't violate without asking)

- **No webapp scope creep.** User explicitly rejected adding FAQ, before/after comparison, sticky CTA, gallery scroll carousel. Keep it **minimal, aesthetic, premium**.
- **Avatar default voice, not Starfish.** Each avatar uses its own HeyGen-paired voice for face/voice match. Timestamps come post-render via ElevenLabs.
- **Engine: avatar_v default, avatar_iv available.** Frontend toggle lives between them. The backend validates the avatar supports the chosen engine before calling HeyGen.
- **Vercel Hobby plan caps Serverless Functions at 300s.** `/api/render` fits comfortably with warm snapshot. `/api/test/generate-video` is fine for ~3min renders. Anything longer needs the webhook pattern.
- **Snapshot rebuilds at every deploy.** `next build && node scripts/create-snapshot.mjs`. Snapshot pointer keyed by `VERCEL_DEPLOYMENT_ID` in Blob. Falls back to fresh setup if pointer missing — non-fatal.
- **All test renders auto-save to `/video/`** with timestamped name + JSON sidecar. MP4s gitignored, JSON committed (one row per render for history).
- **Don't deploy automatically.** User reviews before pushing prod. Local dev OK to run anytime.
- **`/Users/arindam/.claude/CLAUDE.md`** and **`/Users/arindam/Documents/Claude/.claude/CLAUDE.md`** define the global Ari workspace. Auto-loaded.

## Most recent commits (newest first)

```
7f311c3 Swap to curated 7 avatars + bigger circle + per-avatar crop hints
00b091c Validate IV/V engine choice on the backend
066375d Frontend polish: Geist font + interaction bug fixes
70b2fef Cap maxDuration to 300s for Hobby plan compatibility
a9d4cb3 Fix create-snapshot.mjs: timeout must be integer ms
3e2eac8 Add Vercel Sandbox rendering pipeline + Loom-style composition
46f7ac9 Initial Next.js scaffold + HeyGen v3 integration
```

## How to start the next thread

1. Open the project: `code /Users/arindam/Documents/Projects/heygen-hyperframes-outbound`
2. Start the new Claude session there
3. Paste this opener as your first message:

> *"Read [HANDOFF.md](./HANDOFF.md) in this repo. That's the full state. Confirm what's done and let me know what's next — I want to work on [pick one: script generation / scraper / orchestrator / wiring frontend to backend]."*

The fresh Claude will read HANDOFF.md + the live code, give you a 1-paragraph confirmation, and pick up where this thread left off.
