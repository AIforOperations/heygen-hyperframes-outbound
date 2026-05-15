export type GalleryEntry = {
  id: string;
  name: string;
  role: string;
  company: string;
  stat: string;
  accent: string;
  videoUrl?: string;
};

export const GALLERY: GalleryEntry[] = [
  {
    id: "g_joshua",
    name: "Joshua X.",
    role: "Co-Founder and CEO",
    company: "HeyGen",
    stat: "Claude-planned scenes · 9:16 portrait source",
    accent: "#DC2626",
    videoUrl:
      "https://x2aue1n8zm76mdax.public.blob.vercel-storage.com/renders/v2-smoke-2026-05-15T17-00-34-200Z-OohxqB0GJ6KGMl5oomLwP9HfPQmCj3.mp4",
  },
  {
    id: "g0",
    name: "Scott Ford",
    role: "Founder",
    company: "California Builder Services",
    stat: "DRE PDFs autofilled in 0:47 · live form demo",
    accent: "#DC2626",
    videoUrl:
      "https://x2aue1n8zm76mdax.public.blob.vercel-storage.com/renders/scott-leadflow-002-iap4NJod5J6b0y45YZAw5WFKNGJS3Q.mp4",
  },
  {
    id: "g_chase",
    name: "Chase Garcia",
    role: "President",
    company: "Reserve Studies Inc.",
    stat: "3-4h cut per client report · 8-card hyperframes",
    accent: "#991B1B",
    videoUrl:
      "https://x2aue1n8zm76mdax.public.blob.vercel-storage.com/renders/hf_render_07_chase_rsi_personalized_cards-1hkEWk3CkO6Qj9v1JlfXHLGzDiLj1u.mp4",
  },
  {
    id: "g_rbc",
    name: "Orlando",
    role: "RBC contact",
    company: "Royal Bank of Canada",
    stat: "LeftClick · Leos avatar · RBC prototype",
    accent: "#1f3a5f",
    videoUrl:
      "https://x2aue1n8zm76mdax.public.blob.vercel-storage.com/renders/rbc-orlando-v5-EZULlimX265snP9OpPPzsj4HC4iMVy.mp4",
  },
];
