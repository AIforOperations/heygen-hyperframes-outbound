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
    id: "g0",
    name: "Alice Ford",
    role: "Chief Executive Officer",
    company: "California Builder Services",
    stat: "35+ years DRE consulting · auto-fill demo",
    accent: "#DC2626",
    videoUrl:
      "https://x2aue1n8zm76mdax.public.blob.vercel-storage.com/renders/2026-05-15T13-46-47-498Z-nutwmLmf41NG0tbHCiNzWjoezws6dn.mp4",
  },
  {
    id: "g1",
    name: "Jane Smith",
    role: "VP Marketing",
    company: "Acme Corp",
    stat: "Homepage loads in 4.2s",
    accent: "#DC2626",
  },
  {
    id: "g2",
    name: "David Chen",
    role: "Head of Growth",
    company: "Northwind Labs",
    stat: "Hiring 11 SDRs, no marketing ops",
    accent: "#F87171",
  },
  {
    id: "g3",
    name: "Maya Patel",
    role: "COO",
    company: "Forge & Co",
    stat: "Still on Webflow at $5M ARR",
    accent: "#991B1B",
  },
  {
    id: "g4",
    name: "Tom Reynolds",
    role: "CRO",
    company: "Bluetail",
    stat: "Glassdoor 3.1 — culture cited",
    accent: "#7c1d6f",
  },
];
