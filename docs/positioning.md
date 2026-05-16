# Product Positioning Doc

For HeyGen WTD Hackathon (May 2026). Use this to write promotional scripts, demo voiceovers, landing page copy, and pitch material.

---

## The product in one line

Your cloned AI avatar sending custom analyst-style videos to high-value contacts, with synced visuals showing each person's company data on screen as you talk.

---

## Why this product makes sense

### The market shifted three times in 18 months

1. Cold email reply rates fell from 8.5% (2019) to 3.43% (Instantly Benchmark Report 2026). Plain text is dead.
2. AI-generated emails get 90% lower response than truly personalized ones (Martal 2026). AI text is also dead.
3. Generic AI avatar videos (Sendspark, Potion, Tavus) are now common enough that prospects spot them. Generic AI video is dying too.

### What still works

- Real-person 1:1 video (Loom, Bonjoro selfie videos): 2-4x reply lift vs text
- Specific, data-grounded relevance to the prospect: 3x reply lift (Sendspark case studies)
- LinkedIn DM and warm-reply channels: no deliverability problem, no spam filters

### The gap

Nobody combines the three. Real-looking avatar (not stock), specific data-grounded message (not template), and visuals that show the prospect's own company on screen. That gap is what this product fills.

---

## The pain point it solves

### Who feels it

- Solo founders running their own outbound
- Consultants and agency owners doing 1:1 BD
- Executive recruiters reaching senior candidates
- VC associates sourcing deals
- Customer success leaders re-engaging stalled accounts
- SDRs and account executives doing ABM on 30-50 named accounts

### What they're stuck with today

- **Loom and Vidyard work, but they don't scale.** You have to record every video yourself. 30 prospects means 30 takes, 30 retries, sitting in front of a camera for 60 to 90 minutes. Then you redo half of them because you stumbled on a name or said the wrong company. Most founders and SDRs quit after week one.
- **Potion (formerly SendPotion):** record one base video, swap placeholder names. Mouth doesn't match the swapped word. Prospects notice. Same script for everyone.
- **Sendspark:** same as Potion. Placeholder personalization. No company-specific content on screen.
- **Synthesia:** corporate training tool. Stock avatars, no outbound workflow, no personalization layer.
- **Tavus:** real-time conversational AI. Different product entirely. You can't pre-render 50 personalized videos for outbound.
- **HeyGen direct API:** the engine, not the product. You'd have to build the pipeline, the scraping, the script generation, the visual layer yourself.

### The result

Everyone reaches for the same playbook: a generic 60-second talking head with the prospect's first name typed in the message. Reply rates are 1-2%. The video itself is treated as a marginal upgrade over text, not as the actual reason the prospect responds.

---

## The manual recording trap

Loom and Vidyard solved the wrong half of the problem. Recording one video to one person works, the reply rates prove it. The problem is that doing it 30 or 50 or 100 times in a week is unrealistic for anyone who has an actual job.

The math:

- One personalized video takes about 3 minutes to record well: 30 seconds to research the prospect, 1 minute of takes, 30 seconds to redo a fumble, 1 minute to upload and send.
- 30 prospects in a week = 90 minutes of camera time. Plus the research before, plus the redos when you fumble a name.
- You have to look presentable on every take. Lighting, audio, no background noise, no kids walking in.
- Half the videos get redone because you said "Acme" when you meant "Acmey" or you blanked on the prospect's role.
- By Wednesday you're tired. By Friday you've quit. The campaign dies.

That is why every Loom-style outbound program peaks in week one and dies by week three. The tool works. The human running it can't keep up.

This product collapses the 90 minutes into 90 seconds per video. Same output quality, same personal feel, none of the camera fatigue. Record your avatar once, send 1000 videos.

---

## What this product does (in plain terms)

You paste a LinkedIn URL. 90 seconds later you have a 30-second video where your cloned avatar speaks to that person by name, mentions their exact company and role, calls out a specific data point about their business, and shows visuals on screen that are 100% about them. Their logo. Their photo. Their site speed. Their tech stack. Their hiring trend.

Same structure, totally different output per prospect. Built on top of HeyGen.

---

## How it works (the flow)

1. **Paste LinkedIn URL** of the prospect
2. **Scrape** profile and company via Apify
3. **Enrich** with one specific data point worth mentioning, pulled from BuiltWith (tech stack), PageSpeed (site speed), Glassdoor (employee sentiment), LinkedIn hiring data, or SimilarWeb (traffic trend). The system tries each source in order and picks the first one with a clear angle.
4. **Generate script** via Claude. Four beats: greeting, company observation, specific stat, proposed fix. 30 seconds total.
5. **Render avatar** through HeyGen API using the user's own cloned avatar (or a chosen stock avatar for the demo).
6. **Layer Hyperframes** on top of the avatar video. Each beat triggers a different on-screen visual: name card, company logo, stat callout chart, fix preview. Transitions land on word-level timestamps so visuals flip on the exact word, not a guess.
7. **Output**: one MP4 per prospect, ready to send via LinkedIn DM, email, or hosted page.

The hard part is timing. HeyGen returns word-level timestamps. Hyperframes need to swap on phrase boundaries, not mid-word. The composer maps each beat to the nearest sentence-end timestamp and transitions there. If a phrase runs long, the visual holds. If short, it cross-fades early. No ugly cuts.

---

## The unique positioning

### What everyone else does

| Tool | What they offer | What's missing |
|------|-----------------|----------------|
| Vidyard | Manual recording, video hosting | No AI, no scale, every video is hand-recorded |
| Loom | Manual recording, sharing | Same. Plus no overlays beyond face cam |
| Potion (SendPotion) | Talking head with placeholder name swap | One base script. Same scene. No company-specific visuals |
| Sendspark | Placeholder name personalization + AI avatars | No data-grounded script. No on-screen company visuals |
| Synthesia | Stock AI avatars for training videos | Not built for outbound. No 1:1 personalization workflow |
| Tavus | Real-time AI conversation video | Different category. Not for pre-rendered 1:1 outbound |
| HeyGen (direct) | Avatar engine + Hyperframes SDK | You build the full pipeline yourself |

### What this product does that none of them do

- **Your cloned avatar, not a stock one.** Trust signal. Prospects recognize the founder, the consultant, the SDR. It's not "an AI presenter." It's you, scaled.
- **Claude writes the script per prospect.** Not Mad Libs name swap. The script references their specific stat, their actual role, their real company situation. Different sentences for different prospects, not the same script with a name inserted.
- **Hyperframes show their company on screen.** Logo, photo, stat as a chart, fix preview. The prospect watches their own business get analyzed in real time. Vidyard, Loom, Potion, Sendspark cannot do this.
- **Built on HeyGen, not competing with it.** Hyperframes is HeyGen's own visual overlay system. This product is the workflow layer on top: scrape, enrich, write, render, compose, deliver.
- **Channel-correct.** Designed for LinkedIn DM, warm reply chains, post-demo follow-up, closed-lost re-engagement. Not cold email. Sidesteps every deliverability problem.

### The one-sentence pitch

The only outbound video tool where the prospect watches their own company on screen, with a script written specifically for them, delivered by an avatar that looks and sounds like you.

---

## Pricing thesis (for context, not promo copy)

- Solo plan: $79 to $149 per month. Enough for ~50 to 100 videos.
- Agency plan: $499 to $1,499 per month, multi-seat, white label
- Enterprise: custom

Per-video COGS at scale (HeyGen API + Hyperframes + scraping + Claude tokens) stays under $0.50. Margin holds even at lowest tier.

---

## Real impact numbers to cite

- Cold email reply rate 2026: 3.43% (Instantly Benchmark Report 2026)
- Personalized video reply rate vs text: 3x lift (Sendspark, multiple sources)
- Warm video DM reply rates: 30 to 50% in published case studies (Bonjoro, Sendspark)
- Sendr platform data: 0.5% meeting rate from 17,000 videos vs 0.1% industry baseline. 5x lift on meetings booked.
- Closed-lost re-engagement campaign with AI video: $100K ARR booked in one month (Sendspark blog, Dec 2025)
- Viewer retention: 95% of video content vs 10% of text (industry standard)

---

## The companies we replace or beat

- **Vidyard** ($110M+ raised, video hosting + manual recording): we automate the recording
- **Loom** (acquired by Atlassian for $975M, manual screen and face recording): we replace manual takes with cloned avatar at scale
- **Potion** (formerly SendPotion, talking head placeholder swap): we replace placeholder Mad Libs with real per-prospect scripts and on-screen company visuals
- **Sendspark** ($3.8M revenue 2024, AI avatar + placeholder swap): same as Potion. We add the data layer and visual layer.
- **Synthesia** ($2B+ valuation, corporate training videos): different use case. We are not training. We are outbound.
- **Tavus** ($64M raised, real-time conversational AI): different product entirely. Not async outbound.

---

## The companies we depend on (and why that's fine)

- **HeyGen** ($100M ARR, $500M valuation): avatar engine + Hyperframes SDK. We compete in their hackathon. Best-case outcome is partnership or acquihire.
- **Anthropic Claude**: script generation. Swappable with GPT if needed.
- **Apify**: LinkedIn scraping. Swappable with Phantombuster or manual paste-in.
- **BuiltWith, PageSpeed Insights, SimilarWeb**: enrichment data sources. Swappable.

The avatar engine and Hyperframes are HeyGen-locked by design. That is the differentiator, not a risk.

---

## Best demo angle (for hackathon and promo)

Side-by-side comparison. Same prospect. Three versions:

1. **Generic talking head** (any stock AI avatar, generic script)
2. **Placeholder-swap video** (Potion or Sendspark style)
3. **This product**: cloned avatar, custom script, company-specific Hyperframes

Show all three. Let viewers see the difference in 30 seconds. That visual is the entire pitch.

---

## Tone and language for scripts

- Plain and direct. No filler words.
- Speak to the result, not the technology.
- Use the prospect's perspective: "You paste a URL, you get a video back."
- Numbers and specifics over adjectives. "30-second video, 90 seconds to render, sent in 2 clicks" beats "fast and easy."
- Banned words (per Ari's writing rules): seamlessly, vibrant, cutting-edge, leverage, robust, transformative, streamline, comprehensive, harness, elevate, empower, paradigm, synergy, holistic, optimize, facilitate, scalable, ecosystem, end-to-end.

---

## Three-line elevator pitch (for opening hook)

> Cold outbound is dead. Generic AI video is dying. The only thing that still works is a real person talking to you about your specific business. This product gives every founder, SDR, and consultant a cloned version of themselves that does exactly that, at scale, with your prospect's actual company data on screen as you talk.
