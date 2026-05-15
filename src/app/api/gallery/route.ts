import { NextResponse } from "next/server";
import { listCompletedJobs } from "@/lib/jobs";
import { GALLERY as STATIC_GALLERY, type GalleryEntry } from "@/lib/gallery";

/**
 * GET /api/gallery
 *
 * Returns the merged gallery, newest first:
 *   1. All completed pipeline jobs (with outputUrl) read from Vercel Blob
 *   2. Static seed entries from src/lib/gallery.ts as a fallback / fill
 *
 * Dynamic entries are derived from JobState and shaped to GalleryEntry so the
 * UI doesn't need to know about jobs at all.
 */

export const runtime = "nodejs";
export const revalidate = 0; // always fresh

const ACCENTS = ["#DC2626", "#F87171", "#991B1B", "#7c1d6f", "#1f3a5f", "#374151"];

function accentForIndex(i: number): string {
  return ACCENTS[i % ACCENTS.length];
}

export async function GET() {
  const jobs = (await listCompletedJobs(20)) ?? [];

  const dynamic: GalleryEntry[] = jobs.map((j, i) => {
    const lead = j.lead;
    const firstName = lead?.firstName ?? lead?.fullName ?? "Prospect";
    const fullName = lead?.fullName ?? firstName;
    const role = lead?.role ?? "—";
    const company = lead?.company?.name ?? j.input?.input?.value ?? "—";
    return {
      id: `job-${j.jobId}`,
      name: fullName,
      role,
      company,
      stat: shortStat(j),
      accent: accentForIndex(i),
      videoUrl: j.outputUrl,
    };
  });

  // De-dupe static seeds that are already represented by jobs (rare but
  // possible when Alice has both the seed entry and a real job).
  const dynamicCompanies = new Set(
    dynamic.map((d) => d.company?.toLowerCase()).filter(Boolean)
  );
  const seed = STATIC_GALLERY.filter(
    (s) => !dynamicCompanies.has(s.company?.toLowerCase())
  );

  return NextResponse.json({
    ok: true,
    entries: [...dynamic, ...seed],
    dynamicCount: dynamic.length,
    seedCount: seed.length,
  });
}

function shortStat(job: { wordCount?: number; heygenDuration?: number; lead?: { company?: { name?: string | null } | null } }): string {
  if (job.heygenDuration) {
    const sec = Math.round(job.heygenDuration);
    const wc = job.wordCount ? `${job.wordCount}-word script` : "personalized";
    return `${sec}s · ${wc}`;
  }
  return "Personalized outbound video";
}
