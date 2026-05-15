import "server-only";
import { CURATED_AVATARS, type AvatarCrop } from "./avatars";
import type { SandboxFile } from "./composition-files";

/**
 * Server-side composition builder. Same HTML/CSS layout as
 * scripts/build-composition.mjs, but produces SandboxFile[] in memory so the
 * orchestrator can pipe it straight into renderInSandbox() without touching
 * disk.
 *
 * Inputs:
 *   - mp4: Buffer of the rendered HeyGen avatar video
 *   - duration: total video length in seconds
 *   - avatarId: used to look up the per-avatar crop hint
 *   - cards: optional override for the right-column title cards
 *
 * Output: [{ path: "index.html", content }, { path: "assets/avatar.mp4", content }]
 */

export interface CompositionCard {
  id: string;
  start: number;
  end: number;
  eyebrow: string;
  headline: string;
  headline2?: string;
}

export interface BuildCompositionInput {
  mp4: Buffer;
  duration: number;
  avatarId: string;
  cards?: CompositionCard[];
}

const DEFAULT_CROP: AvatarCrop = { positionY: "30%", scale: 1.0, originY: "30%" };

function cropForAvatar(avatarId: string): AvatarCrop {
  const found = CURATED_AVATARS.find((a) => a.id === avatarId);
  return found?.crop ?? DEFAULT_CROP;
}

function defaultCards(duration: number): CompositionCard[] {
  const cards: CompositionCard[] = [
    {
      id: "card-intro",
      start: 0.0,
      end: 4.0,
      eyebrow: "AIforOperations",
      headline: "Personalized outbound,",
      headline2: "on autopilot.",
    },
    {
      id: "card-promise",
      start: 4.0,
      end: 8.0,
      eyebrow: "Every prospect.",
      headline: "Different video.",
      headline2: "Same workflow.",
    },
    {
      id: "card-tech",
      start: 8.0,
      end: duration,
      eyebrow: "Built on",
      headline: "HeyGen × HyperFrames",
    },
  ];
  return cards
    .filter((c) => c.start < duration)
    .map((c) => ({ ...c, end: Math.min(c.end, duration) }));
}

function escape(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildHtml(opts: {
  duration: number;
  crop: AvatarCrop;
  cards: CompositionCard[];
}): string {
  const { duration, crop, cards } = opts;
  const durFixed = duration.toFixed(3);

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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>AIforOperations · HyperFrames demo</title>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #F8F2E6;
      --bg-2: #F1E9D8;
      --text: #1F1A14;
      --text-2: #5C5246;
      --primary: #DC2626;
      --primary-light: #F87171;
      --accent: #C2410C;
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
      object-position: 50% var(--avatar-pos-y, 30%);
      transform: scale(var(--avatar-scale, 1.0));
      transform-origin: 50% var(--avatar-origin-y, 30%);
    }
    .right-col {
      position: absolute;
      left: 760px;
      top: 0;
      width: 1080px;
      height: 1080px;
      padding: 0 80px 0 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
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
      animation: progressFill ${durFixed}s linear forwards;
    }
    @keyframes progressFill {
      from { transform: scaleX(0); }
      to   { transform: scaleX(1); }
    }
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
    .card-headline + .card-headline { color: var(--accent); }
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
       data-composition-duration="${durFixed}"
       data-width="1920"
       data-height="1080"
       data-start="0"
       data-duration="${durFixed}">

    <div id="avatar-ring" class="avatar-ring"
         style="--avatar-scale: ${crop.scale}; --avatar-pos-y: ${crop.positionY}; --avatar-origin-y: ${crop.originY};">
      <video
        id="avatar"
        class="clip"
        src="assets/avatar.mp4"
        muted
        playsinline
        data-start="0"
        data-duration="${durFixed}"
        data-track-index="1"></video>
    </div>

    <audio
      id="avatar-audio"
      class="clip"
      src="assets/avatar.mp4"
      data-start="0"
      data-duration="${durFixed}"
      data-track-index="6"
      data-volume="1"></audio>

    <div id="wordmark" class="wordmark clip"
      data-start="0"
      data-duration="${durFixed}"
      data-track-index="2">
      <span class="ai">AI</span><span class="for">for</span><span class="ops">Operations</span>
    </div>

    <div id="right-col" class="right-col clip"
      data-start="0"
      data-duration="${durFixed}"
      data-track-index="3">
${cardHtml}
    </div>

    <div id="progress" class="progress clip"
      data-start="0"
      data-duration="${durFixed}"
      data-track-index="5">
      <div class="progress-fill"></div>
    </div>
  </div>

  <script>
    document.querySelectorAll(".card").forEach((el) => {
      const dur = parseFloat(el.getAttribute("data-duration")) || 4;
      el.style.setProperty("--card-duration", dur + "s");
    });
    window.__timelines = window.__timelines || {};
    window.__timelines["demo-01"] = null;
  </script>
</body>
</html>
`;
}

export function buildCompositionFiles(input: BuildCompositionInput): SandboxFile[] {
  if (!Number.isFinite(input.duration) || input.duration <= 0) {
    throw new Error(`composition duration is invalid: ${input.duration}`);
  }

  const crop = cropForAvatar(input.avatarId);
  const cards = input.cards ?? defaultCards(input.duration);
  const html = buildHtml({ duration: input.duration, crop, cards });

  return [
    { path: "index.html", content: Buffer.from(html, "utf8") },
    { path: "assets/avatar.mp4", content: input.mp4 },
  ];
}
