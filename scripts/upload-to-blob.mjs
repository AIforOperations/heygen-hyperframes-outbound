#!/usr/bin/env node
/**
 * Upload a local file to Vercel Blob and print the public URL.
 *
 *   node scripts/upload-to-blob.mjs <local-file> [<blob-pathname>]
 *
 * If <blob-pathname> is omitted the file's basename is used (under renders/).
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { put } from "@vercel/blob";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const envText = readFileSync(path.join(REPO, ".env.local"), "utf8");
let token = (envText.match(/^BLOB_READ_WRITE_TOKEN=(.+)$/m) || [])[1]?.trim();
if (!token) { console.error("BLOB_READ_WRITE_TOKEN missing in .env.local"); process.exit(1); }
// Strip surrounding quotes if present (vercel env pull writes "..." values)
if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
  token = token.slice(1, -1);
}

const [, , src, destArg] = process.argv;
if (!src) { console.error("usage: upload-to-blob.mjs <local-file> [<dest>]"); process.exit(2); }
const localPath = path.resolve(REPO, src);
if (!existsSync(localPath)) { console.error("file not found: " + localPath); process.exit(1); }

const dest = destArg || `renders/${path.basename(localPath)}`;
const size = statSync(localPath).size;
console.log(`→ uploading ${path.relative(REPO, localPath)} (${(size / 1024 / 1024).toFixed(1)} MB) → ${dest}`);

const data = readFileSync(localPath);
const result = await put(dest, data, {
  access: "public",
  contentType: "video/mp4",
  token,
  allowOverwrite: true,
  addRandomSuffix: true,
});
console.log("✓ url: " + result.url);
