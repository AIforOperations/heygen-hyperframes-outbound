/**
 * Composition compiler.
 *
 * Input:  validated scene plan JSON (Claude's output) + path to repo root.
 * Output: a complete HyperFrames composition directory under
 *         public/compositions/<compositionId>/, ready to be rendered with
 *         `npx hyperframes render`.
 *
 * The compiler:
 *   1. Loads compositions/registry.json
 *   2. Validates each scene in the plan against the registry + its own schema
 *   3. Resolves image fallbacks (initials + accent color) for missing URLs
 *   4. Substitutes {{var}} and {{#var}}…{{/var}} / {{^var}}…{{/var}} blocks
 *      in each scene's composition.html
 *   5. Assembles one parent index.html with:
 *        - locked avatar slot
 *        - tokens.css + layout.css imported from _shared/
 *        - each scene's resolved HTML inlined into the parent body
 *        - GSAP + parent timeline registry script
 *
 * Compiler-injected per-scene placeholders:
 *   {{__scene_start__}}     replaced by scene.start  (seconds)
 *   {{__scene_duration__}}  replaced by scene.duration (seconds)
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const GZ_W = 1096;
const GZ_H = 952;

// ---------- Plan schema ----------
const PLAN_SCHEMA = {
  type: "object",
  required: ["compositionId", "duration", "avatar", "scenes"],
  additionalProperties: false,
  properties: {
    compositionId: { type: "string", pattern: "^[a-z0-9_-]+$", minLength: 3, maxLength: 80 },
    duration: { type: "number", minimum: 5, maximum: 60 },
    avatar: {
      type: "object",
      required: ["avatarId", "videoPath"],
      additionalProperties: false,
      properties: {
        avatarId: { type: "string" },
        videoPath: { type: "string" },
        crop: {
          type: "object",
          additionalProperties: false,
          properties: {
            positionY: { type: "string" },
            scale: { type: "number", minimum: 0.5, maximum: 3 },
            originY: { type: "string" },
          },
        },
      },
    },
    scenes: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        required: ["id", "templateId", "start", "duration", "variables"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z0-9_-]+$" },
          templateId: { type: "string", pattern: "^[a-z0-9_-]+$" },
          start: { type: "number", minimum: 0 },
          duration: { type: "number", minimum: 0.5, maximum: 30 },
          variables: { type: "object" },
        },
      },
    },
  },
};

// ---------- Public API ----------
export function compileComposition({ repoRoot, plan, outDir, branding, wordTimestamps }) {
  // `branding` is the sender's brand identity for the persistent wordmark.
  // Falls back to a neutral mark when not provided (e.g. when scripts/* CLI
  // tools call the compiler without a sender context).
  const senderBranding = {
    senderName: branding?.senderName?.trim() || "",
    senderCompany: branding?.senderCompany?.trim() || "",
  };
  // `wordTimestamps` is the raw ElevenLabs Scribe output. When present, the
  // compiler builds a bottom-right captions track timed to actual speech
  // boundaries (3-4 words per window, fades governed by hyperframes' clip
  // visibility model). When absent, no captions render.
  const captionWindows = wordTimestamps?.length
    ? chunkCaptionsFromWords(wordTimestamps, plan.duration)
    : [];
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validatePlan = ajv.compile(PLAN_SCHEMA);
  if (!validatePlan(plan)) {
    throw new ValidationError("Scene plan failed schema validation", validatePlan.errors);
  }

  // Load registry
  const registryPath = path.join(repoRoot, "compositions/registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const byId = new Map(registry.scenes.map((s) => [s.id, s]));

  // Per-scene validation (registry + scene schema + duration window + ordering)
  const errors = [];
  const resolvedScenes = [];
  let prevEnd = -Infinity;
  for (const scene of plan.scenes) {
    const tpl = byId.get(scene.templateId);
    if (!tpl) {
      errors.push(`scene "${scene.id}": templateId "${scene.templateId}" not in registry`);
      continue;
    }
    // Duration window
    const [minD, maxD] = tpl.durationRange;
    if (scene.duration < minD || scene.duration > maxD) {
      errors.push(
        `scene "${scene.id}" (${scene.templateId}): duration ${scene.duration}s outside allowed range [${minD}, ${maxD}]`
      );
      continue;
    }
    // Validate user-supplied variables against per-scene schema (BEFORE fallback fill)
    const sceneSchemaPath = path.join(repoRoot, "compositions", tpl.schema);
    const sceneSchema = JSON.parse(readFileSync(sceneSchemaPath, "utf8"));
    const validateVars = ajv.compile(sceneSchema);
    if (!validateVars(scene.variables)) {
      errors.push(
        `scene "${scene.id}" (${scene.templateId}) variables failed validation: ` +
          JSON.stringify(validateVars.errors)
      );
      continue;
    }
    const filledVars = enrichVariables(scene.variables, tpl);
    // No-overlap (allow back-to-back; allow ≤ 0.2s gap)
    if (scene.start < prevEnd - 0.001) {
      errors.push(
        `scene "${scene.id}" starts at ${scene.start}s but previous scene ended at ${prevEnd}s (overlap)`
      );
    }
    prevEnd = scene.start + scene.duration;

    resolvedScenes.push({
      ...scene,
      template: tpl,
      variables: filledVars,
    });
  }
  // Total duration must cover [0, duration]
  if (resolvedScenes.length > 0) {
    if (resolvedScenes[0].start > 0.2) {
      errors.push(`first scene starts at ${resolvedScenes[0].start}s — should be at 0`);
    }
    const last = resolvedScenes[resolvedScenes.length - 1];
    const totalEnd = last.start + last.duration;
    if (Math.abs(totalEnd - plan.duration) > 0.2) {
      errors.push(`scenes end at ${totalEnd}s but plan duration is ${plan.duration}s`);
    }
  }
  if (errors.length) {
    throw new ValidationError("Scene plan validation failed", errors);
  }

  // ---------- Build output ----------
  mkdirSync(outDir, { recursive: true });
  const assetsDir = path.join(outDir, "assets");
  const sharedDir = path.join(outDir, "_shared");
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(sharedDir, { recursive: true });

  // Load shared CSS so we can inline it (avoids file:// 404s during render)
  const tokensCss = readFileSync(
    path.join(repoRoot, "compositions/_shared/tokens.css"),
    "utf8"
  );
  const layoutCss = readFileSync(
    path.join(repoRoot, "compositions/_shared/layout.css"),
    "utf8"
  );
  // Motion library is a shared JS DSL inlined into every render so each
  // scene's <script> can call window.LF.{fadeUp, scalePop, counter, ...}
  // instead of hand-rolling GSAP. Keeps timings + easings consistent.
  const motionJs = readFileSync(
    path.join(repoRoot, "compositions/_shared/motion.js"),
    "utf8"
  );
  // Also copy them to _shared/ for direct browser inspection during dev
  for (const f of ["tokens.css", "layout.css"]) {
    copyFileSync(
      path.join(repoRoot, "compositions/_shared", f),
      path.join(sharedDir, f)
    );
  }

  // Copy avatar mp4
  const srcMp4 = path.isAbsolute(plan.avatar.videoPath)
    ? plan.avatar.videoPath
    : path.join(repoRoot, plan.avatar.videoPath);
  if (!existsSync(srcMp4)) {
    throw new Error(`avatar video not found: ${srcMp4}`);
  }
  copyFileSync(srcMp4, path.join(assetsDir, "avatar.mp4"));

  // Resolve scene HTML
  const sceneFragments = resolvedScenes.map((s) =>
    renderSceneFragment({ repoRoot, scene: s })
  );

  // Crop fallback
  const crop = plan.avatar.crop ?? { positionY: "30%", scale: 1.0, originY: "30%" };

  // Assemble parent index.html
  const masterTimelineMounts = resolvedScenes.map((s) => ({
    instanceId: s.id,
    start: s.start,
    duration: s.duration,
  }));
  const html = renderParent({
    plan,
    sceneFragments,
    crop,
    tokensCss,
    layoutCss,
    motionJs,
    masterTimelineMounts,
    branding: senderBranding,
    captionWindows,
  });
  writeFileSync(path.join(outDir, "index.html"), html);

  return {
    outDir,
    scenes: resolvedScenes.length,
    durationS: plan.duration,
  };
}

// ---------- Helpers ----------

export class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

function enrichVariables(vars, tpl) {
  const out = { ...vars };
  // Generic accent default
  if (!out.accent_color) out.accent_color = "#DC2626";

  // Template-specific compile-time expansions (rows → pre-rendered HTML)
  if (tpl.id === "chart-comparison-v1" && Array.isArray(out.rows)) {
    out.__rows__ = out.rows
      .map((r) => {
        const cls = r.highlight ? "row highlight" : "row";
        const pct = Number(r.value_percent) || 0;
        return `<div class="${cls}">
        <div class="row-label">${escapeHtml(r.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="--pct: ${pct}"></div></div>
        <div class="row-value">${escapeHtml(r.value_display)}</div>
      </div>`;
      })
      .join("\n      ");
  }

  if (tpl.id === "form-autofill-v1" && Array.isArray(out.form_fields)) {
    const checkSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    out.__rows__ = out.form_fields
      .map(
        (f) => `<div class="row">
        <div class="row-label">${escapeHtml(f.label)}</div>
        <div class="row-value">${escapeHtml(f.value)}</div>
        <div class="check">${checkSvg}</div>
      </div>`
      )
      .join("\n      ");
  }

  // For each declared imagery slot, ensure fallback companions exist
  const imagery = tpl.imagery || {};
  for (const imageVar of Object.keys(imagery)) {
    const url = (out[imageVar] || "").trim();
    out[imageVar] = url;
    const baseName = imageVar.replace(/_url$/, "");
    const fbTextKey = `${baseName}_fallback_text`;
    const fbColorKey = `${baseName}_fallback_color`;

    if (!out[fbTextKey]) {
      // Try to derive: prospect_image -> initials of prospect_name; company_logo -> first letter of company_name
      out[fbTextKey] = deriveFallbackText(baseName, out) || "•";
    }
    if (!out[fbColorKey]) {
      out[fbColorKey] = colorFromString(out[fbTextKey] || baseName);
    }
  }
  return out;
}

function deriveFallbackText(baseName, vars) {
  const lookup = {
    profile_image: vars.prospect_name,
    profile_picture: vars.prospect_name,
    company_logo: vars.company_name,
    sender_logo: vars.sender_company,
  };
  const src = lookup[baseName];
  if (!src) return null;
  const parts = src.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFromString(s) {
  const palette = ["#DC2626", "#F87171", "#991B1B", "#C2410C", "#1E40AF", "#7c1d6f", "#374151"];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Minimal Mustache-ish substitution. Supports {{var}} (escaped), {{{var}}}
// (raw HTML), {{#var}}…{{/var}}, {{^var}}…{{/var}}. Falsy = empty string /
// undefined / 0 / false / empty array.
function substitute(template, vars) {
  let out = template;
  // Resolve sections from the inside out — keep looping until no more
  // section tags exist. The non-greedy regex naturally picks innermost
  // sections first on each pass.
  const sec = /\{\{#([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
  const inv = /\{\{\^([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
  for (let i = 0; i < 8; i++) {
    const before = out;
    out = out.replace(sec, (_m, key, body) => {
      const v = vars[key];
      const truthy = Array.isArray(v) ? v.length > 0 : !!v;
      return truthy ? body : "";
    });
    out = out.replace(inv, (_m, key, body) => {
      const v = vars[key];
      const truthy = Array.isArray(v) ? v.length > 0 : !!v;
      return !truthy ? body : "";
    });
    if (out === before) break;
  }
  // Raw HTML injection {{{var}}} — used for pre-rendered compiler output.
  out = out.replace(/\{\{\{([a-zA-Z0-9_]+)\}\}\}/g, (_m, key) => {
    const v = vars[key];
    if (v === undefined || v === null) return "";
    return String(v);
  });
  out = out.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, key) => {
    const v = vars[key];
    if (v === undefined || v === null) return "";
    return escapeHtml(v);
  });
  return out;
}

function renderSceneFragment({ repoRoot, scene }) {
  const tplDir = path.join(repoRoot, "compositions", "scenes", scene.template.id);
  const tplPath = path.join(tplDir, "composition.html");
  const tpl = readFileSync(tplPath, "utf8");
  const vars = {
    ...scene.variables,
    __scene_start__: scene.start.toFixed(3),
    __scene_duration__: scene.duration.toFixed(3),
    __instance_id__: scene.id,
  };
  let fragment = substitute(tpl, vars);
  // Rewrite the template's root selector to the unique instance id so the
  // same template can be used multiple times in one composition without
  // duplicate-id collisions or CSS conflicts.
  const templateId = scene.template.id;
  const instanceId = scene.id;
  if (templateId !== instanceId) {
    const escTpl = templateId.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    fragment = fragment
      .replace(new RegExp(`#${escTpl}\\b`, "g"), `#${instanceId}`)
      .replace(new RegExp(`id="${escTpl}"`, "g"), `id="${instanceId}"`)
      .replace(new RegExp(`data-composition-id="${escTpl}"`, "g"), `data-composition-id="${instanceId}"`)
      .replace(new RegExp(`__timelines\\["${escTpl}"\\]`, "g"), `__timelines["${instanceId}"]`)
      .replace(new RegExp(`data-scene="${escTpl}"`, "g"), `data-scene="${instanceId}"`);
  }
  return fragment;
}

/**
 * Chunk ElevenLabs word_timestamps into ~3-4 word caption windows.
 *
 * Each window is a single on-screen line; one replaces the previous at the
 * start of the next chunk's first word, so there's no gap or flicker. We
 * also break early at sentence-end punctuation (. ! ?) so the line doesn't
 * straddle a beat boundary, and we collapse the space-before-punct that
 * Scribe's word array produces ("calls ." → "calls.").
 *
 * Output shape: [{ text, start, duration }]. Duration is stretched to the
 * next chunk's start so each caption stays visible until replaced.
 */
function chunkCaptionsFromWords(words, totalDuration) {
  const wordsOnly = (words || []).filter(
    (w) => w && w.type === "word" && typeof w.text === "string"
  );
  if (!wordsOnly.length) return [];

  const chunks = [];
  let buf = [];
  for (const w of wordsOnly) {
    buf.push(w);
    const endsSentence = /[.!?]$/.test(w.text);
    if (buf.length >= 4 || endsSentence) {
      chunks.push(buildChunk(buf));
      buf = [];
    }
  }
  if (buf.length) chunks.push(buildChunk(buf));

  for (let i = 0; i < chunks.length; i++) {
    const next = chunks[i + 1];
    const naturalDur = Math.max(0.3, chunks[i].end - chunks[i].start);
    chunks[i].duration = next
      ? Math.max(0.3, next.start - chunks[i].start)
      : Math.max(naturalDur + 0.3, totalDuration - chunks[i].start);
  }
  return chunks;
}

function buildChunk(buf) {
  const text = buf
    .map((x) => x.text)
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
  return {
    text,
    start: Number(buf[0].start) || 0,
    end: Number(buf[buf.length - 1].end) || 0,
  };
}

function renderParent({ plan, sceneFragments, crop, tokensCss, layoutCss, motionJs, masterTimelineMounts, branding, captionWindows }) {
  const duration = plan.duration.toFixed(3);
  const compId = plan.compositionId;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(compId)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <script>
/* ===== inlined: _shared/motion.js ===== */
${motionJs}
  </script>
  <style>
/* ===== inlined: _shared/tokens.css ===== */
${tokensCss}
/* ===== inlined: _shared/layout.css ===== */
${layoutCss}
  </style>
  <style>
    #root {
      position: relative;
      width: var(--canvas-w);
      height: var(--canvas-h);
      font-family: "Inter", system-ui, sans-serif;
      overflow: hidden;
      background:
        radial-gradient(ellipse 45% 50% at 18% 50%, rgba(220, 38, 38, 0.10), transparent 70%),
        radial-gradient(ellipse 60% 80% at 105% 50%, rgba(194, 65, 12, 0.06), transparent 60%),
        linear-gradient(135deg, #FAF5E9 0%, #F1E9D8 100%);
    }
    .avatar-ring {
      position: absolute;
      left: var(--avatar-x);
      top: var(--avatar-y);
      width: var(--avatar-size);
      height: var(--avatar-size);
      border-radius: 50%;
      overflow: hidden;
      box-shadow:
        0 0 0 7px #ffffff,
        0 0 0 12px rgba(220, 38, 38, 0.85),
        var(--shadow-card-strong);
      background: var(--bg-2);
      z-index: 5;
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
    .scene-mount {
      position: absolute;
      left: var(--gz-x);
      top: var(--gz-y);
      width: var(--gz-w);
      height: var(--gz-h);
      overflow: hidden;
      z-index: 2;
    }
    .wordmark {
      position: absolute;
      top: 56px;
      right: 80px;
      font-size: 32px;
      font-weight: var(--weight-bold);
      letter-spacing: 0;
      display: flex;
      gap: 0;
      align-items: center;
      z-index: 10;
      color: var(--text);
      /* Inter ss02 serifs the capital I so adjacent A·I doesn't read as A·l.
         cv11 picks the disambiguating lowercase l with a tail.            */
      font-feature-settings: "ss02", "cv11";
    }
    .wordmark .brand-name {
      /* Color the trailing characters in brand-red when there's a natural
         split, otherwise the whole mark renders in --text. Split is purely
         visual; planner doesn't have to know about it.                    */
      color: var(--text);
    }
    .wordmark .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--brand-red);
      margin-right: 12px;
      box-shadow: 0 0 0 4px rgba(220, 38, 38, 0.18);
    }
    /* Captions own the bottom 300px of the canvas, full-width centered.
       Each <div.caption-window> is a hyperframes clip — visibility is
       governed by data-start/data-duration, so they swap without overlap
       (the next window's start equals the prior window's end). The bottom
       300px (y=720..1020) is RESERVED for this track. No scene mount or
       chrome ever renders below y=720. See _shared/layout.css --cap-top. */
    .captions {
      position: absolute;
      left: 50%;
      top: var(--cap-top, 720px);
      transform: translateX(-50%);
      width: 1440px;
      max-width: 75%;
      height: var(--cap-h, 300px);
      text-align: center;
      pointer-events: none;
      z-index: 11;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .caption-window {
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 100%;
      text-align: center;
      font-family: "Inter", system-ui, sans-serif;
      font-size: 56px;
      font-weight: 600;
      letter-spacing: -0.015em;
      line-height: 1.18;
      color: var(--text);
      font-feature-settings: "ss02", "cv11";
      text-shadow:
        0 1px 0 rgba(255, 255, 255, 0.55),
        0 2px 14px rgba(0, 0, 0, 0.08);
      white-space: normal;
      word-break: normal;
      padding: 0 80px;
    }
    .progress-fill {
      position: absolute;
      inset: 0 auto 0 0;
      width: 100%;
      transform-origin: left center;
      background: linear-gradient(90deg, var(--brand-red) 0%, var(--brand-red-light) 100%);
      animation: progressFill ${duration}s linear forwards;
    }
    @keyframes progressFill {
      from { transform: scaleX(0); }
      to   { transform: scaleX(1); }
    }
  </style>
</head>
<body>
  <div id="root"
       data-composition-id="${escapeHtml(compId)}"
       data-composition-duration="${duration}"
       data-width="1920"
       data-height="1080"
       data-start="0"
       data-duration="${duration}">

    <!-- ===== Avatar slot (locked) ===== -->
    <div id="avatar-ring" class="avatar-ring"
         style="--avatar-scale: ${crop.scale}; --avatar-pos-y: ${crop.positionY}; --avatar-origin-y: ${crop.originY};">
      <video
        id="avatar-video"
        class="clip"
        src="assets/avatar.mp4"
        muted
        playsinline
        data-start="0"
        data-duration="${duration}"
        data-track-index="2"></video>
    </div>
    <audio id="avatar-audio"
           class="clip"
           src="assets/avatar.mp4"
           data-start="0"
           data-duration="${duration}"
           data-track-index="6"
           data-volume="1"></audio>

    <!-- ===== Wordmark + Progress (chrome) ===== -->
${branding?.senderCompany ? `    <div id="wordmark" class="wordmark clip" data-start="0" data-duration="${duration}" data-track-index="9">
      <span class="dot"></span><span class="brand-name">${escapeHtml(branding.senderCompany)}</span>
    </div>` : ""}

    ${(captionWindows || []).length ? `<div id="captions" class="captions">
${captionWindows.map((w, i) => `      <div class="caption-window clip" data-start="${w.start.toFixed(3)}" data-duration="${w.duration.toFixed(3)}" data-track-index="12">${escapeHtml(w.text)}</div>`).join("\n")}
    </div>` : ""}

    <!-- ===== Scenes ===== -->
${sceneFragments
  .map(
    (frag) => `    <div class="scene-mount">
${indent(frag, 6)}
    </div>`
  )
  .join("\n")}

  </div>

  <script>
    // Assemble the master timeline: nest each scene's sub-timeline at its
    // global start offset. The HyperFrames renderer seeks the timeline
    // registered under the root composition id, which propagates seeks
    // through the nested children. This is the ONLY timeline the renderer
    // looks at — the per-scene registry entries are inputs to this step.
    (function () {
      window.__timelines = window.__timelines || {};
      if (typeof gsap === "undefined") {
        window.__timelines[${JSON.stringify(compId)}] = null;
        return;
      }
      const master = gsap.timeline({ paused: true });
      const mounts = ${JSON.stringify(masterTimelineMounts)};
      for (const m of mounts) {
        const child = window.__timelines[m.instanceId];
        if (child && typeof child.duration === "function") {
          // Pad child to match the scene's mount duration so its final
          // state holds for the entire time the scene is on screen.
          const pad = m.duration - child.duration();
          if (pad > 0.01) child.to({}, { duration: pad });
          master.add(child, m.start);
        }
      }
      window.__timelines[${JSON.stringify(compId)}] = master;
    })();
  </script>
</body>
</html>
`;
}

function indent(s, n) {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((line) => (line.length ? pad + line : line))
    .join("\n");
}
