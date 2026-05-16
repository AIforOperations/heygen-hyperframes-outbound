# Scene authoring contract

Every scene under `compositions/scenes/<id>/` MUST follow this contract.
The compiler enforces it; non-conformant scenes are rejected.

## Required files

```
<scene-id>/
  composition.html   # the scene markup (HyperFrames composition)
  schema.json        # JSON Schema for the scene's variables
  fixture.json       # default values that render the scene standalone
```

## Composition rules

1. **Root must be `<div id="root" class="graphics-zone">`** with these attributes:
   - `data-composition-id="<scene-id>"`
   - `data-composition-duration="<seconds>"`
   - `data-width="1096"` (graphics zone width — do NOT change)
   - `data-height="952"` (graphics zone height — do NOT change)

2. **All visible content lives inside `.graphics-zone`.** No absolute positioning that escapes those bounds.

3. **Every timed element has `class="clip"` + `data-start` + `data-duration`.**

4. **No `<html>`, `<head>`, or `<body>` tags.** Scenes are HTML fragments that the compiler embeds inside the parent's `<body>`. Stylesheets are loaded by the parent.

5. **Variable substitution uses `{{var_name}}` placeholders.** The compiler replaces these. Available variables come from `schema.json`.

6. **Register a paused GSAP timeline in `window.__timelines["<scene-id>"]`** if your scene uses GSAP. Otherwise set to `null`.

7. **Scoped CSS only.** Inline scoped styles must be wrapped under `#<scene-id> { ... }` to prevent collision across scenes in the bundled parent.

## Variable conventions

- `prospect_*` — fields about the person being pitched
- `company_*` — fields about the prospect's company
- `sender_*` — fields about the user generating the video
- `image_*` — image URLs; every image variable has companion fallback fields:
  - `<image>_fallback_text` (string, e.g. "JS")
  - `<image>_fallback_color` (hex)
  The compiler fills these automatically if the URL is missing.

## Forbidden

- Loading external CSS or JS (except GSAP from CDN, which the parent already includes).
- `position: fixed` (breaks rendering).
- `<video>` or `<audio>` tags (avatar audio is owned by the parent).
- Hardcoding brand colors — always use CSS variables from `tokens.css`.

## Registering the scene

After authoring, add an entry to `compositions/registry.json`:

```json
{
  "id": "intro-v1",
  "category": "intro",
  "variant": "fade",
  "motion": "fade",
  "density": "sparse",
  "accent": "red",
  "durationRange": [3, 6],
  "schema": "scenes/intro-v1/schema.json",
  "fixture": "scenes/intro-v1/fixture.json"
}
```
