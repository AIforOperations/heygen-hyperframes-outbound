/**
 * Curated avatar list. IDs are stable; preview URLs are presigned and expire,
 * so we fetch fresh URLs server-side via /api/avatars on each page load.
 */

export interface CuratedAvatar {
  id: string;
  // Display label shown in the UI (overrides HeyGen's stock name when needed)
  label: string;
  style: string;
  // Starfish-engine voice that gender/style-matches the avatar.
  // We MUST use a Starfish voice to get word_timestamps back from
  // /v3/voices/speech — those drive hyperframe overlay sync.
  voiceId: string;
  voiceName: string;
  // Falls back to this if HeyGen's preview URL is missing or expired
  fallbackColor: string;
}

export const CURATED_AVATARS: CuratedAvatar[] = [
  {
    id: "c3df4083b7dd49ba9c34bd0d43738a4c",
    label: "Ari",
    style: "Founder, AIforOperations",
    voiceId: "01f98ed43e6140349f47dbd37a416827",
    voiceName: "Cody (M)",
    fallbackColor: "#DC2626",
  },
  {
    id: "ed822d92ced6420abde4a1dd5d8b103b",
    label: "Tony",
    style: "Executive, urban",
    voiceId: "01c42cddcfdc4665a57b8d89cba8ffc1",
    voiceName: "Shaun (M)",
    fallbackColor: "#991B1B",
  },
  {
    id: "f047b6a3dda740fe8b6c94b24c668c5f",
    label: "Knox",
    style: "Modern, working pro",
    voiceId: "02d5366a90af4c7a87157808ff352e33",
    voiceName: "Rami (M)",
    fallbackColor: "#1f3a5f",
  },
  {
    id: "f5d499bb3d224ba4b157bf7a8e8e53a6",
    label: "Sawyer",
    style: "Calm presenter",
    voiceId: "01d674cfd32b4728a3fddd21b7e7d543",
    voiceName: "Senthil (M)",
    fallbackColor: "#374151",
  },
  {
    id: "f594844a5f6c4167b525c9e2f5b07471",
    label: "Carolyn",
    style: "Approachable advisor",
    voiceId: "007e1378fc454a9f976db570ba6164a7",
    voiceName: "Aria (F)",
    fallbackColor: "#a52a2a",
  },
  {
    id: "aed64d6b270a45248498db9a5ce11907",
    label: "Devan",
    style: "Podcast host",
    voiceId: "d2f4f24783d04e22ab49ee8fdc3715e0",
    voiceName: "Chill Brian (M)",
    fallbackColor: "#5b21b6",
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
