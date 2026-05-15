#!/usr/bin/env node
/**
 * Build a HyperFrames composition with a Loom-style layout:
 *   - Avatar circle on the left, vertically centered, 614px diameter
 *     (20% larger than the original 512px — encroaches slightly past the
 *     visual 1/3 line but keeps 64px padding from screen edge).
 *   - Right column for animated title cards.
 *
 * Per-avatar crop hints control how the source video is positioned and
 * zoomed inside the circle. These are passed via the metadata sidecar
 * (avatarId + crop fields written by /api/test/generate-video). If the
 * sidecar doesn't include crop hints, default values are used.
 *
 * Usage:
 *   node scripts/build-composition.mjs <metadata.json> <composition-dir>
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const [, , metaArg, compDirArg] = process.argv;
if (!metaArg || !compDirArg) {
  console.error("usage: node scripts/build-composition.mjs <metadata.json> <composition-dir>");
  process.exit(2);
}

const metaPath = path.resolve(ROOT, metaArg);
const compDir = path.resolve(ROOT, compDirArg);
const assetsDir = path.join(compDir, "assets");
mkdirSync(assetsDir, { recursive: true });

const meta = JSON.parse(readFileSync(metaPath, "utf8"));
const duration = Number(meta.duration);
if (!Number.isFinite(duration) || duration <= 0) {
  console.error("metadata.duration missing or invalid");
  process.exit(1);
}

// Resolve per-avatar crop hints. Either the sidecar already carries them
// (preferred) or we look them up by avatarId from the curated config.
let crop = meta.crop ?? null;
if (!crop && meta.avatarId) {
  try {
    // Lazy-load the curated module since it's ESM/TS — read raw text.
    const avatarsTs = readFileSync(path.join(ROOT, "src/lib/avatars.ts"), "utf8");
    // Quick regex grab — looking for the avatar's entry by id
    const idMatch = avatarsTs.indexOf(`id: "${meta.avatarId}"`);
    if (idMatch !== -1) {
      const tail = avatarsTs.slice(idMatch, idMatch + 1500);
      const cropMatch = tail.match(/crop:\s*\{\s*positionY:\s*"([^"]+)",\s*scale:\s*([0-9.]+),\s*originY:\s*"([^"]+)"/);
      if (cropMatch) {
        crop = {
          positionY: cropMatch[1],
          scale: parseFloat(cropMatch[2]),
          originY: cropMatch[3],
        };
      }
    }
  } catch (e) {
    console.warn("could not resolve crop from avatars.ts:", e.message);
  }
}
crop = crop ?? { positionY: "30%", scale: 1.0, originY: "30%" };
console.log(`  crop: scale=${crop.scale}, origin-y=${crop.originY}, pos-y=${crop.positionY}`);

// Copy MP4 source alongside JSON → assets/avatar.mp4
const mp4Source = metaPath.replace(/\.json$/, ".mp4");
const mp4Target = path.join(assetsDir, "avatar.mp4");
if (!existsSync(mp4Source)) {
  console.error(`source MP4 not found: ${mp4Source}`);
  process.exit(1);
}
copyFileSync(mp4Source, mp4Target);

// Title-card beats. For now, fixed placeholders sized to fit the visible
// duration. Each card: { start, end, headline, subhead?, kind }
function buildCards(totalDuration) {
  const cards = [
    {
      id: "card-intro",
      start: 0.0,
      end: 4.0,
      kind: "headline",
      eyebrow: "AIforOperations",
      headline: "Personalized outbound,",
      headline2: "on autopilot.",
    },
    {
      id: "card-promise",
      start: 4.0,
      end: 8.0,
      kind: "promise",
      eyebrow: "Every prospect.",
      headline: "Different video.",
      headline2: "Same workflow.",
    },
    {
      id: "card-tech",
      start: 8.0,
      end: totalDuration,
      kind: "tech",
      eyebrow: "Built on",
      headline: "HeyGen × HyperFrames",
      headline2: "",
    },
  ];
  return cards
    .filter((c) => c.start < totalDuration)
    .map((c) => ({ ...c, end: Math.min(c.end, totalDuration) }));
}

const cards = buildCards(duration);

const cardHtml = cards
  .map((c) => {
    const dur = Math.max(0.1, c.end - c.start).toFixed(3);
    return `      <div id="${c.id}" class="card clip"
        data-start="${c.start.toFixed(3)}"
        data-duration="${dur}"
        data-track-index="4">
        <div class="card-eyebrow">${escape(c.eyebrow)}</div>
        <div class="card-headline">${escape(c.headline)}</div>
        ${c.headline2 ? `<div class="card-headline">${escape(c.headline2)}</div>` : ""}
      </div>`;
  })
  .join("\n");

function escape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>AIforOperations · HyperFrames demo</title>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    :root {
      /* Warm cream / editorial palette — common in modern B2B sales decks */
      --bg: #F8F2E6;        /* warm cream base */
      --bg-2: #F1E9D8;      /* slightly deeper cream */
      --text: #1F1A14;      /* near-black with warm tint */
      --text-2: #5C5246;    /* muted warm gray for secondary copy */
      --primary: #DC2626;
      --primary-light: #F87171;
      --accent: #C2410C;    /* warm orange-red for the secondary headline pop */
    }
    html, body { margin: 0; padding: 0; background: var(--bg); }
    #root {
      position: relative;
      width: 1920px;
      height: 1080px;
      font-family: "Sora", system-ui, sans-serif;
      color: var(--text);
      overflow: hidden;
      background:
        radial-gradient(ellipse 45% 50% at 18% 50%, rgba(220, 38, 38, 0.10), transparent 70%),
        radial-gradient(ellipse 60% 80% at 105% 50%, rgba(194, 65, 12, 0.06), transparent 60%),
        linear-gradient(135deg, #FAF5E9 0%, #F1E9D8 100%);
    }

    /* ===== Avatar circle =====
       614px diameter (20% larger than original 512). Keeps 64px padding
       from the left edge of the 1920-wide frame, encroaching ~38px past
       the visual 1/3 line (1920/3 = 640). Vertically centered.
         left = 64
         right edge = 64 + 614 = 678
         top = (1080 - 614) / 2 = 233
    */
    .avatar-ring {
      position: absolute;
      left: 64px;
      top: 233px;
      width: 614px;
      height: 614px;
      border-radius: 50%;
      overflow: hidden;
      box-shadow:
        0 0 0 7px #ffffff,
        0 0 0 12px rgba(220, 38, 38, 0.85),
        0 40px 80px rgba(80, 30, 10, 0.20),
        0 12px 36px rgba(80, 30, 10, 0.12);
      background: var(--bg-2);
    }
    .avatar-ring video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      /* Per-avatar crop values get inlined via CSS variables below */
      object-position: 50% var(--avatar-pos-y, 30%);
      transform: scale(var(--avatar-scale, 1.0));
      transform-origin: 50% var(--avatar-origin-y, 30%);
    }

    /* ===== Right column =====
       Bumped from left:720 → left:760 to give the larger circle a 82px
       gutter (was 42px). Right column width adjusted accordingly.
    */
    .right-col {
      position: absolute;
      left: 760px;
      top: 0;
      width: 1080px;        /* 1920 - 760 - 80 padding right */
      height: 1080px;
      padding: 0 80px 0 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    /* Static wordmark in the top-right corner */
    .wordmark {
      position: absolute;
      top: 56px;
      right: 80px;
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.01em;
      display: flex;
      gap: 4px;
      align-items: baseline;
    }
    .wordmark .ai { color: var(--text); }
    .wordmark .for { color: var(--primary-light); }
    .wordmark .ops { color: var(--primary); }

    /* Small progress strip along the bottom */
    .progress {
      position: absolute;
      left: 80px;
      right: 80px;
      bottom: 64px;
      height: 4px;
      border-radius: 999px;
      background: rgba(31, 26, 20, 0.10);
      overflow: hidden;
    }
    .progress-fill {
      position: absolute;
      inset: 0 auto 0 0;
      width: 100%;
      transform-origin: left center;
      background: linear-gradient(90deg, var(--primary) 0%, var(--primary-light) 100%);
      animation: progressFill ${duration.toFixed(3)}s linear forwards;
    }
    @keyframes progressFill {
      from { transform: scaleX(0); }
      to   { transform: scaleX(1); }
    }

    /* ===== Title cards (right column) ===== */
    .card {
      position: relative;
      max-width: 980px;
      animation: cardEnter 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both,
                 cardExit 0.45s cubic-bezier(0.4, 0, 0.4, 1) both;
      animation-delay: 0s, calc(var(--card-duration, 4s) - 0.45s);
    }
    .card-eyebrow {
      display: inline-block;
      padding: 10px 22px;
      border-radius: 999px;
      background: var(--primary);
      color: #ffffff;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: 0.02em;
      margin-bottom: 32px;
      box-shadow: 0 6px 18px rgba(220, 38, 38, 0.28);
    }
    .card-headline {
      font-size: 104px;
      font-weight: 700;
      line-height: 1.02;
      letter-spacing: -0.025em;
      color: var(--text);
    }
    .card-headline + .card-headline {
      color: var(--accent);
    }

    @keyframes cardEnter {
      0%   { opacity: 0; transform: translateY(28px); filter: blur(8px); }
      100% { opacity: 1; transform: translateY(0);    filter: blur(0);   }
    }
    @keyframes cardExit {
      0%   { opacity: 1; transform: translateY(0);     filter: blur(0);   }
      100% { opacity: 0; transform: translateY(-14px); filter: blur(6px); }
    }
  </style>
</head>
<body>
  <div id="root"
       data-composition-id="demo-01"
       data-composition-duration="${duration.toFixed(3)}"
       data-width="1920"
       data-height="1080"
       data-start="0"
       data-duration="${duration.toFixed(3)}">

    <!-- Avatar in circle, vertically centered. Wrapper is a non-timed
         visual container (no class="clip", no data-start); the <video>
         inside owns timing so HyperFrames manages playback. Per-avatar
         crop variables are inlined so each avatar gets the right zoom +
         vertical framing inside the circle. -->
    <div id="avatar-ring" class="avatar-ring"
         style="--avatar-scale: ${crop.scale}; --avatar-pos-y: ${crop.positionY}; --avatar-origin-y: ${crop.originY};">
      <video
        id="avatar"
        class="clip"
        src="assets/avatar.mp4"
        muted
        playsinline
        data-start="0"
        data-duration="${duration.toFixed(3)}"
        data-track-index="1"></video>
    </div>

    <!-- Parallel audio so sound survives the render -->
    <audio
      id="avatar-audio"
      class="clip"
      src="assets/avatar.mp4"
      data-start="0"
      data-duration="${duration.toFixed(3)}"
      data-track-index="6"
      data-volume="1"></audio>

    <!-- Wordmark, top-right -->
    <div id="wordmark" class="wordmark clip"
      data-start="0"
      data-duration="${duration.toFixed(3)}"
      data-track-index="2">
      <span class="ai">AI</span><span class="for">for</span><span class="ops">Operations</span>
    </div>

    <!-- Right column: title cards swap over time -->
    <div id="right-col" class="right-col clip"
      data-start="0"
      data-duration="${duration.toFixed(3)}"
      data-track-index="3">
${cardHtml}
    </div>

    <!-- Progress strip along bottom -->
    <div id="progress" class="progress clip"
      data-start="0"
      data-duration="${duration.toFixed(3)}"
      data-track-index="5">
      <div class="progress-fill"></div>
    </div>
  </div>

  <script>
    // Set per-card animation duration var so cardExit fires at the right time
    document.querySelectorAll(".card").forEach((el) => {
      const dur = parseFloat(el.getAttribute("data-duration")) || 4;
      el.style.setProperty("--card-duration", dur + "s");
    });

    // HyperFrames timeline registry (no GSAP timelines here yet)
    window.__timelines = window.__timelines || {};
    window.__timelines["demo-01"] = null;
  </script>
</body>
</html>
`;

writeFileSync(path.join(compDir, "index.html"), html);
console.log(`✓ wrote ${path.relative(ROOT, path.join(compDir, "index.html"))}`);
console.log(`  duration: ${duration}s`);
console.log(`  cards: ${cards.length}`);
console.log(`  base video: ${path.relative(ROOT, mp4Target)}`);
