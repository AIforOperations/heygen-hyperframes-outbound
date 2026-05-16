#!/usr/bin/env node
/**
 * Compile a scene plan into a HyperFrames-renderable composition directory.
 *
 *   node scripts/compile-composition.mjs <plan.json> <output-dir>
 *
 * Plan shape: see scripts/lib/composition-compiler.mjs (PLAN_SCHEMA).
 *
 * Output: ready-to-render. Pass it to:
 *   npx hyperframes render <output-dir> -o <out.mp4> --workers auto
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  compileComposition,
  ValidationError,
} from "./lib/composition-compiler.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const [, , planArg, outArg] = process.argv;
if (!planArg || !outArg) {
  console.error("usage: node scripts/compile-composition.mjs <plan.json> <output-dir>");
  process.exit(2);
}

const planPath = path.resolve(REPO, planArg);
const outDir = path.resolve(REPO, outArg);
const plan = JSON.parse(readFileSync(planPath, "utf8"));

try {
  const result = compileComposition({ repoRoot: REPO, plan, outDir });
  console.log(`✓ wrote ${path.relative(REPO, result.outDir)}/index.html`);
  console.log(`  scenes: ${result.scenes}  duration: ${result.durationS}s`);
  console.log(`  next: npx hyperframes render ${path.relative(REPO, outDir)} -o out.mp4`);
} catch (err) {
  if (err instanceof ValidationError) {
    console.error("✗ validation failed:", err.message);
    console.error(JSON.stringify(err.details, null, 2));
    process.exit(1);
  }
  throw err;
}
