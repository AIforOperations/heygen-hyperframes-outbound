import "server-only";
import { Sandbox } from "@vercel/sandbox";
import { head, put } from "@vercel/blob";
import type { SandboxFile } from "./composition-files";

/**
 * Vercel Sandbox orchestration for HyperFrames rendering.
 *
 * Cold-path (no snapshot): create sandbox → install Chromium deps + hyperframes
 *   → run `npx hyperframes browser ensure` → snapshot it.
 *
 * Hot-path (snapshot in Blob): create sandbox from snapshot → write composition
 *   files → run `npx --no-install hyperframes render composition -o out.mp4`
 *   → read out.mp4 as Buffer → return.
 *
 * In dev (no VERCEL=1) we always go cold-path and skip snapshot caching, so
 * `vercel env pull` is enough to test locally without a deploy.
 */

// Pin sandbox sizing. standard-4 (4 vCPU) is what the template uses.
const SANDBOX_RESOURCES = {
  vcpus: 4,
  // memory: omitted → Vercel picks the default for vcpus tier
} as const;

// Time budgets
const SETUP_TIMEOUT_MS = 15 * 60 * 1000; // 15 min — cold setup includes Chrome download
const RENDER_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per render

const SNAPSHOT_POINTER_PREFIX = "snapshot-cache/";

interface SnapshotPointer {
  snapshotId: string;
  createdAt: string;
  hyperframesVersion: string;
}

function snapshotPointerKey(): string {
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID ?? "dev";
  return `${SNAPSHOT_POINTER_PREFIX}${deploymentId}.json`;
}

async function readSnapshotPointer(): Promise<SnapshotPointer | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const meta = await head(snapshotPointerKey());
    const resp = await fetch(meta.url);
    if (!resp.ok) return null;
    return (await resp.json()) as SnapshotPointer;
  } catch {
    return null;
  }
}

async function writeSnapshotPointer(p: SnapshotPointer): Promise<void> {
  await put(snapshotPointerKey(), JSON.stringify(p, null, 2), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

/**
 * Restore a sandbox from the cached snapshot if available; otherwise create
 * a fresh one and run the full prepare sequence.
 */
async function restoreOrCreate(): Promise<{ sandbox: Sandbox; fromSnapshot: boolean }> {
  const pointer = await readSnapshotPointer();
  if (pointer) {
    try {
      const sandbox = await Sandbox.create({
        source: { type: "snapshot", snapshotId: pointer.snapshotId },
        resources: SANDBOX_RESOURCES,
        timeout: RENDER_TIMEOUT_MS,
      });
      return { sandbox, fromSnapshot: true };
    } catch (err) {
      console.warn(
        "[sandbox] snapshot restore failed, falling back to fresh setup",
        err
      );
    }
  }

  const sandbox = await Sandbox.create({
    resources: SANDBOX_RESOURCES,
    timeout: SETUP_TIMEOUT_MS,
  });
  await prepareSandbox(sandbox);
  return { sandbox, fromSnapshot: false };
}

/**
 * Install Chromium system deps and hyperframes inside a fresh sandbox.
 * Mirrors the canonical sequence from the official Vercel template.
 */
async function prepareSandbox(sandbox: Sandbox): Promise<void> {
  await Promise.all([
    runStep(sandbox, "dnf install (chromium deps)", {
      cmd: "dnf",
      args: [
        "install",
        "-y",
        "--setopt=install_weak_deps=False",
        "nss",
        "nspr",
        "atk",
        "at-spi2-atk",
        "cups-libs",
        "libdrm",
        "libxkbcommon",
        "libXcomposite",
        "libXdamage",
        "libXext",
        "libXfixes",
        "libXrandr",
        "mesa-libgbm",
        "alsa-lib",
        "pango",
      ],
      sudo: true,
    }),
    runStep(sandbox, "npm install hyperframes + ffmpeg-static + ffprobe-static", {
      cmd: "npm",
      args: [
        "install",
        "--no-save",
        "--no-audit",
        "--no-fund",
        "hyperframes@latest",
        "ffmpeg-static",
        "ffprobe-static",
      ],
    }),
  ]);

  // Wire ffmpeg-static / ffprobe-static binaries onto PATH so the hyperframes
  // CLI finds them.
  await runStep(sandbox, "symlink ffmpeg", {
    cmd: "bash",
    args: [
      "-c",
      "ln -sf $(node -p \"require('ffmpeg-static')\") /usr/local/bin/ffmpeg && " +
        "ln -sf $(node -p \"require('ffprobe-static').path\") /usr/local/bin/ffprobe",
    ],
    sudo: true,
  });

  // Pre-download the headless Chrome shell so renders don't pay that cost.
  await runStep(sandbox, "hyperframes browser ensure", {
    cmd: "npx",
    args: ["--no-install", "hyperframes", "browser", "ensure"],
  });
}

interface RunStepOpts {
  cmd: string;
  args: string[];
  sudo?: boolean;
}

async function runStep(sandbox: Sandbox, label: string, opts: RunStepOpts): Promise<void> {
  const cmd = await sandbox.runCommand({
    cmd: opts.cmd,
    args: opts.args,
    sudo: opts.sudo,
  });
  const exit = await cmd.wait();
  if (exit.exitCode !== 0) {
    const stderr = await cmd.stderr();
    throw new Error(
      `[sandbox] step "${label}" exited ${exit.exitCode}: ${stderr.slice(0, 2000)}`
    );
  }
}

/**
 * Run the full render flow inside a sandbox and return the resulting MP4.
 *
 * `files` is the flat list produced by collectCompositionFiles().
 * Files are written under the `composition/` prefix inside the sandbox.
 */
export interface RenderResult {
  mp4: Buffer;
  fromSnapshot: boolean;
  totalMs: number;
  setupMs: number;
  renderMs: number;
}

export async function renderInSandbox(files: SandboxFile[]): Promise<RenderResult> {
  const startedAt = Date.now();

  const { sandbox, fromSnapshot } = await restoreOrCreate();
  const setupMs = Date.now() - startedAt;

  try {
    // Write composition files into composition/
    await sandbox.writeFiles(
      files.map((f) => ({ path: `composition/${f.path}`, content: f.content }))
    );

    // Run the renderer
    const renderStart = Date.now();
    await runStep(sandbox, "hyperframes render", {
      cmd: "npx",
      args: [
        "--no-install",
        "hyperframes",
        "render",
        "composition",
        "-o",
        "out.mp4",
        "--workers",
        "auto",
      ],
    });
    const renderMs = Date.now() - renderStart;

    // Read result back as a Buffer
    const mp4 = await sandbox.readFileToBuffer({ path: "out.mp4" });
    if (!mp4) {
      throw new Error("[sandbox] out.mp4 not found after render — renderer may have failed silently");
    }

    return { mp4, fromSnapshot, totalMs: Date.now() - startedAt, setupMs, renderMs };
  } finally {
    await sandbox.stop().catch(() => {});
  }
}

/**
 * Build a snapshot and cache its ID for fast cold starts. Called from
 * scripts/create-snapshot.mjs at deploy time.
 */
export async function buildAndCacheSnapshot(): Promise<SnapshotPointer> {
  const sandbox = await Sandbox.create({
    resources: SANDBOX_RESOURCES,
    timeout: SETUP_TIMEOUT_MS,
  });
  try {
    await prepareSandbox(sandbox);
    const { snapshotId } = await sandbox.snapshot();
    const pointer: SnapshotPointer = {
      snapshotId,
      createdAt: new Date().toISOString(),
      hyperframesVersion: "latest",
    };
    await writeSnapshotPointer(pointer);
    return pointer;
  } finally {
    await sandbox.stop().catch(() => {});
  }
}
