/**
 * Curated avatar list. IDs are stable; preview URLs are presigned and expire,
 * so we fetch fresh URLs server-side via /api/avatars on each page load.
 */

export interface CuratedAvatar {
  id: string;
  // Display label shown in the UI (overrides HeyGen's stock name when needed)
  label: string;
  style: string;
  // Falls back to this if HeyGen's preview URL is missing or expired
  fallbackColor: string;
}

export const CURATED_AVATARS: CuratedAvatar[] = [
  {
    id: "c3df4083b7dd49ba9c34bd0d43738a4c",
    label: "Ari",
    style: "Founder, AIforOperations",
    fallbackColor: "#DC2626",
  },
  {
    id: "ed822d92ced6420abde4a1dd5d8b103b",
    label: "Tony",
    style: "Executive, urban",
    fallbackColor: "#991B1B",
  },
  {
    id: "f047b6a3dda740fe8b6c94b24c668c5f",
    label: "Knox",
    style: "Modern, working pro",
    fallbackColor: "#1f3a5f",
  },
  {
    id: "f5d499bb3d224ba4b157bf7a8e8e53a6",
    label: "Sawyer",
    style: "Calm presenter",
    fallbackColor: "#374151",
  },
  {
    id: "f594844a5f6c4167b525c9e2f5b07471",
    label: "Carolyn",
    style: "Approachable advisor",
    fallbackColor: "#a52a2a",
  },
  {
    id: "aed64d6b270a45248498db9a5ce11907",
    label: "Devan",
    style: "Podcast host",
    fallbackColor: "#5b21b6",
  },
];

export interface ResolvedAvatar extends CuratedAvatar {
  previewImageUrl: string | null;
  previewVideoUrl: string | null;
  defaultVoiceId: string | null;
  supportedEngines: ("avatar_v" | "avatar_iv")[];
}
