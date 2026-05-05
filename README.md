# Personalized Outbound Videos with HeyGen + Hyperframes

A hackathon project for the HeyGen WTD hackathon (May 2026).

## What it does

Drop in a LinkedIn URL. The system scrapes the person's profile and company, pulls one specific stat about their business, and generates a 30-second personalized video.

A HeyGen avatar talks to them by name. Hyperframes layer their company logo, profile photo, the stat we pulled, and a quick take on how we'd improve it.

Most outbound videos are generic talking heads. This is a person watching their own company get analyzed on screen in 30 seconds. Much harder to ignore.

## Why this is interesting

Calling the HeyGen API is easy. The hard problem is timing. Getting the avatar's words to land on the right hyperframe at the right beat is what makes the result feel like a produced segment instead of a slideshow with a voiceover.

## Tools

| Tool | Purpose |
|------|---------|
| HeyGen API | Avatar video generation, voice cloning, lip sync |
| Hyperframes | Layered visual elements synced to avatar speech |
| Apify / Phantombuster | LinkedIn profile + company scraping |
| BuiltWith | Tech stack + site speed signals |
| SerpAPI | Logo + photo lookups |
| OpenAI / Claude | Script generation from scraped data |
| Node.js | Backend orchestration |
| Remotion | Fallback for hyperframe composition if needed |

## Flow

```
LinkedIn URL
    │
    ▼
Scrape profile + company        ← Apify
    │
    ▼
Pull one stat                   ← BuiltWith, Glassdoor, hiring data
    │
    ▼
Generate script
(greeting → observation → fix)  ← Claude / GPT
    │
    ▼
HeyGen avatar video             ← HeyGen API
    │
    ▼
Hyperframes layer
(logo, photo, stat, fix)        ← Hyperframes
    │
    ▼
Sync hyperframe timing
to avatar speech beats
    │
    ▼
Final 30-second video
```

## Script structure

Each video follows the same beat sheet:

1. **0 to 5s** Greeting by name. Hyperframe shows their photo + name card.
2. **5 to 12s** Mention their company and role. Hyperframe morphs to company logo + tagline.
3. **12 to 22s** State the specific stat we found. Hyperframe shows the stat as a chart or callout.
4. **22 to 30s** Quick take on how we'd improve it. Hyperframe shows a before/after or fix preview.

Same structure, totally different content per prospect.

## Demo plan

5 real prospects from public LinkedIn profiles. Generate videos for each. Show side-by-side comparison: generic talking head vs avatar with hyperframes. If time allows, send a small batch and track open / reply rates.

## Why this wins

- B2B revenue use case, not a toy
- Shows HeyGen at scale (1 to 1000 unique videos), not just a single demo render
- The hyperframe sync problem is technically real, not surface-level glue code
- Visually distinct from every other "talking head avatar" submission

## Status

Submitted for HeyGen WTD hackathon. Building if accepted.

## Author

Ari
