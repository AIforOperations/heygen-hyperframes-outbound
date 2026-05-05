# Architecture

## High-level

Single Node.js orchestrator that calls four services in sequence: scrape, enrich, generate, compose.

## Components

### 1. Scraper

Input: LinkedIn URL
Output: JSON with name, role, company, company URL, headline

Uses Apify's LinkedIn actor. Falls back to manual paste-in if scrape blocked.

```json
{
  "name": "Jane Smith",
  "role": "VP Marketing",
  "company": "Acme Corp",
  "company_url": "acme.com",
  "headline": "Scaling B2B brands"
}
```

### 2. Enricher

Input: company URL
Output: one specific stat worth talking about

Tries in order:
1. BuiltWith for tech stack (e.g. "still on Webflow at $5M ARR")
2. PageSpeed Insights for site speed (e.g. "homepage loads in 4.2s")
3. Glassdoor public rating
4. LinkedIn hiring signals (open roles, headcount change)
5. SimilarWeb traffic trend

First one with a clear angle wins.

### 3. Script generator

Input: profile + stat
Output: 30-second script with timing markers per beat

Calls Claude with a tight prompt. Returns:

```json
{
  "beats": [
    { "start": 0, "end": 5, "text": "Hey Jane, quick one for you.", "frame": "intro_card" },
    { "start": 5, "end": 12, "text": "Saw you're running marketing at Acme.", "frame": "company_logo" },
    { "start": 12, "end": 22, "text": "Your homepage takes 4.2 seconds to load.", "frame": "stat_callout" },
    { "start": 22, "end": 30, "text": "Quick fix could pull that under 1.5s.", "frame": "fix_preview" }
  ]
}
```

### 4. Avatar generator

Input: full script text + voice ID
Output: MP4 of HeyGen avatar speaking the script

Uses HeyGen API's batch video endpoint. Returns rendered MP4 + word-level timestamps.

### 5. Hyperframe composer

Input: avatar MP4 + beats with timing + assets (logo, photo, stat)
Output: final composed video

Layers hyperframes on top of the avatar video, transitioning at beat boundaries. Pulls timing from HeyGen's word timestamps so transitions land on the exact word, not a guess.

## The hard part

HeyGen returns word-level timestamps. Hyperframes need to swap on phrase boundaries, not word boundaries. So the composer maps beats to nearest sentence-end timestamp and transitions there.

If a phrase runs longer than expected, the hyperframe holds. If shorter, it cross-fades early. No ugly cuts mid-word.

## Stack

```
Node.js (orchestrator)
  ├── Apify SDK
  ├── BuiltWith API
  ├── HeyGen API
  ├── Anthropic SDK
  └── Hyperframes SDK (or Remotion fallback)
```

## What gets built first

1. Hard-code one prospect's data, generate the video end to end
2. Add the scrape step
3. Add the enrichment step
4. Batch over 5 prospects
5. Side-by-side comparison render
