/**
 * Curated avatar list. IDs are stable; preview URLs are presigned and expire,
 * so we fetch fresh URLs server-side via /api/avatars on each page load.
 *
 * Each avatar carries a `crop` hint that controls how the source video gets
 * cropped into the circular avatar slot in HyperFrames compositions. Standing
 * avatars need a higher zoom to push the face up to a comfortable size;
 * sitting avatars need less.
 */

export interface AvatarCrop {
  // CSS object-position. For PORTRAIT sources (Ari) the Y value matters —
  // it controls what vertical band of the image shows in a 1:1 viewport.
  // For LANDSCAPE sources, cover already fills the container vertically, so
  // positionY has no effect; only transform scale + origin do.
  positionY: string;
  // CSS transform: scale(N) — zooms in on the face. 1.0 = no zoom.
  scale: number;
  // CSS transform-origin Y — the pivot for the zoom. Smaller % = closer to
  // the top (face) of the source frame.
  originY: string;
}

export interface CuratedAvatar {
  id: string;
  // Display label shown in the UI (overrides HeyGen's stock name when needed)
  label: string;
  style: string;
  // Starfish voice (fallback if the API caller doesn't pass voiceId). The
  // real test endpoint uses the avatar's HeyGen default voice instead.
  voiceId: string;
  voiceName: string;
  fallbackColor: string;
  // How to crop the source video into the circular slot in HyperFrames
  crop: AvatarCrop;
}

export const CURATED_AVATARS: CuratedAvatar[] = [
  // ---- Owner's digital twin ----
  {
    id: "c3df4083b7dd49ba9c34bd0d43738a4c",
    label: "Ari",
    style: "Founder, AIforOperations",
    voiceId: "422d037290464f3f9b0ce4a049dd65c3",
    voiceName: "Avatar default",
    fallbackColor: "#DC2626",
    crop: { positionY: "22%", scale: 1.0, originY: "30%" },
  },
  // ---- Public studio avatars (all support avatar_v + avatar_iv) ----
  {
    id: "Annie_Desk_Sitting_Front_2_public",
    label: "Annie",
    style: "Sitting · desk",
    voiceId: "330290724a1b470fb63153f34d4c0183",
    voiceName: "Avatar default",
    fallbackColor: "#F87171",
    crop: { positionY: "30%", scale: 1.25, originY: "30%" },
  },
  {
    id: "Brandon_Office_Sitting_Front_public",
    label: "Brandon",
    style: "Sitting · office",
    voiceId: "513b14b431b64a578c467c480dd0a9c3",
    voiceName: "Avatar default",
    fallbackColor: "#1f3a5f",
    crop: { positionY: "30%", scale: 1.25, originY: "28%" },
  },
  {
    id: "Masha_sitting_office_front",
    label: "Masha",
    style: "Sitting · office",
    voiceId: "4e5c7735901b4481ac6604de3aea6f72",
    voiceName: "Avatar default",
    fallbackColor: "#991B1B",
    crop: { positionY: "30%", scale: 1.20, originY: "30%" },
  },
  {
    id: "Leos_sitting_office_front",
    label: "Leos",
    style: "Sitting · office",
    voiceId: "30bd8b4be4ef40f0ae3ab74a4a0d789e",
    voiceName: "Avatar default",
    fallbackColor: "#374151",
    crop: { positionY: "30%", scale: 1.15, originY: "30%" },
  },
  {
    id: "Joel_standing_mountain_front",
    label: "Joel",
    style: "Standing · mountain",
    voiceId: "54a3995cacda4b2b8198de75327fcefa",
    voiceName: "Avatar default",
    fallbackColor: "#7c1d6f",
    crop: { positionY: "30%", scale: 1.45, originY: "25%" },
  },
  {
    id: "Leszek_standing_outdoorbusiness_front",
    label: "Leszek",
    style: "Standing · outdoor",
    voiceId: "cc6a378bd95c4421b9a2fcf1312c6ddb",
    voiceName: "Avatar default",
    fallbackColor: "#5b21b6",
    crop: { positionY: "30%", scale: 1.40, originY: "28%" },
  },
];

export interface ResolvedAvatar extends CuratedAvatar {
  previewImageUrl: string | null;
  previewVideoUrl: string | null;
  // HeyGen's own default voice for this avatar — we ignore this in practice,
  // since we need a Starfish voice and HeyGen's default isn't always one.
  heygenDefaultVoiceId: string | null;
  supportedEngines: ("avatar_v" | "avatar_iv")[];
}
