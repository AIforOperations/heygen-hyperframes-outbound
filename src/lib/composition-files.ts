import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Recursively collect a composition folder into a flat list of
 * { path, content } pairs ready to write into a Vercel Sandbox.
 *
 * `path` is the relative path inside the destination (e.g. "index.html",
 * "assets/avatar.mp4"). `content` is a Node Buffer — Sandbox handles binary
 * files transparently.
 */
export interface SandboxFile {
  path: string;
  content: Buffer;
}

export async function collectCompositionFiles(
  compositionDir: string
): Promise<SandboxFile[]> {
  const absDir = path.resolve(compositionDir);
  const out: SandboxFile[] = [];
  await walk(absDir, "");
  return out;

  async function walk(dir: string, rel: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absPath, relPath);
      } else if (entry.isFile()) {
        const content = await fs.readFile(absPath);
        out.push({ path: relPath, content });
      }
      // Skip symlinks, sockets, etc.
    }
  }
}
