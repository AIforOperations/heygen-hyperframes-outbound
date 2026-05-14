#!/usr/bin/env node
/**
 * Build the Vercel Sandbox snapshot used by /api/render.
 *
 * Runs at deploy time (`next build && node scripts/create-snapshot.mjs`).
 * Skipped locally — set FORCE_SNAPSHOT=1 to run it from a dev machine.
 *
 * The snapshot pointer is stored in Vercel Blob at
 * snapshot-cache/<deploymentId>.json. /api/render reads that pointer and
 * restores the sandbox from the snapshot for fast cold starts.
 *
 * If anything goes wrong, /api/render falls back to a fresh setup at request
 * time — failure here is non-fatal to the deploy.
 */

import { Sandbox } from "@vercel/sandbox";
import { put } from "@vercel/blob";

const SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const SANDBOX_RESOURCES = { vcpus: 4 };

const isVercelBuild = process.env.VERCEL === "1";
const force = process.env.FORCE_SNAPSHOT === "1";

if (!isVercelBuild && !force) {
  console.log(
    "[snapshot] skipping — not running on Vercel. Set FORCE_SNAPSHOT=1 to run locally."
  );
  process.exit(0);
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.warn(
    "[snapshot] BLOB_READ_WRITE_TOKEN missing — cannot store snapshot pointer. Skipping."
  );
  process.exit(0);
}
if (!process.env.VERCEL_OIDC_TOKEN) {
  console.warn(
    "[snapshot] VERCEL_OIDC_TOKEN missing — sandbox auth will fail. Skipping."
  );
  process.exit(0);
}

const deploymentId = process.env.VERCEL_DEPLOYMENT_ID ?? "dev";
const pointerKey = `snapshot-cache/${deploymentId}.json`;

console.log("[snapshot] creating sandbox…");
const sandbox = await Sandbox.create({
  resources: SANDBOX_RESOURCES,
  timeout: `${Math.floor(SETUP_TIMEOUT_MS / 1000)}s`,
});

async function step(label, opts) {
  console.log(`[snapshot] ▶ ${label}`);
  const cmd = await sandbox.runCommand(opts);
  const exit = await cmd.wait();
  if (exit.exitCode !== 0) {
    const stderr = await cmd.stderr();
    throw new Error(`step "${label}" exited ${exit.exitCode}: ${stderr.slice(0, 2000)}`);
  }
}

try {
  await Promise.all([
    step("dnf install (chromium deps)", {
      cmd: "dnf",
      args: [
        "install", "-y", "--setopt=install_weak_deps=False",
        "nss", "nspr", "atk", "at-spi2-atk", "cups-libs",
        "libdrm", "libxkbcommon", "libXcomposite", "libXdamage",
        "libXext", "libXfixes", "libXrandr", "mesa-libgbm",
        "alsa-lib", "pango",
      ],
      sudo: true,
    }),
    step("npm install hyperframes + ffmpeg", {
      cmd: "npm",
      args: [
        "install", "--no-save", "--no-audit", "--no-fund",
        "hyperframes@latest", "ffmpeg-static", "ffprobe-static",
      ],
    }),
  ]);

  await step("symlink ffmpeg/ffprobe", {
    cmd: "bash",
    args: [
      "-c",
      "ln -sf $(node -p \"require('ffmpeg-static')\") /usr/local/bin/ffmpeg && " +
        "ln -sf $(node -p \"require('ffprobe-static').path\") /usr/local/bin/ffprobe",
    ],
    sudo: true,
  });

  await step("hyperframes browser ensure", {
    cmd: "npx",
    args: ["--no-install", "hyperframes", "browser", "ensure"],
  });

  console.log("[snapshot] taking snapshot…");
  const { snapshotId } = await sandbox.snapshot();
  console.log(`[snapshot] got snapshotId: ${snapshotId}`);

  const pointer = {
    snapshotId,
    createdAt: new Date().toISOString(),
    hyperframesVersion: "latest",
  };

  await put(pointerKey, JSON.stringify(pointer, null, 2), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  console.log(`[snapshot] pointer written to blob://${pointerKey}`);
} catch (err) {
  console.error("[snapshot] failed:", err);
  // Don't block the deploy — /api/render has fresh-setup fallback.
  process.exit(0);
} finally {
  await sandbox.stop().catch(() => {});
}
