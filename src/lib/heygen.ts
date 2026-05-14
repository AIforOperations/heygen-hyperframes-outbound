import "server-only";
import { env } from "./env";

/**
 * HeyGen v3 API client. Server-side only.
 *
 * Canonical flow for our use case:
 *   1. listVoices({ engine: "starfish" })       → pick a voice that returns word timestamps
 *   2. generateSpeech({ text, voiceId })        → get audio_url + word_timestamps
 *   3. uploadAudioAsset(audio_url)              → trade short-TTL URL for a stable asset_id
 *   4. createVideo({ avatarId, audioAssetId })  → kick off Avatar V render
 *   5. getVideo(videoId)                        → poll until completed (or use webhook)
 */

const BASE_URL = "https://api.heygen.com";

// ----- Types -----

export type AvatarType = "studio_avatar" | "digital_twin" | "photo_avatar";
export type AvatarEngine = "avatar_v" | "avatar_iv";
export type VoiceEngine = "starfish" | "elevenlabs" | "panda";
export type VideoStatus = "waiting" | "pending" | "processing" | "completed" | "failed";

export interface AvatarLook {
  id: string;
  name: string;
  avatar_type: AvatarType;
  group_id: string | null;
  preview_image_url: string | null;
  preview_video_url: string | null;
  gender: string | null;
  tags: string[];
  default_voice_id: string | null;
  supported_api_engines: AvatarEngine[];
  image_width: number | null;
  image_height: number | null;
  preferred_orientation: "portrait" | "landscape" | "square" | null;
  status: "processing" | "pending_consent" | "failed" | "completed" | null;
}

export interface PaginatedList<T> {
  data: T[];
  has_more: boolean;
  next_token: string | null;
}

export interface Voice {
  voice_id: string;
  language: string;
  gender: string;
  name: string;
  preview_audio: string | null;
  support_pause: boolean;
  emotion_support: boolean;
  support_interactive_avatar: boolean;
  support_locale: boolean;
  // Marker used to filter on word-timestamp capability:
  // Starfish engine voices return word_timestamps in the speech response.
  engine?: VoiceEngine;
}

export interface WordTimestamp {
  word: string;
  start: number; // seconds
  end: number;   // seconds
}

export interface SpeechResult {
  audio_url: string;
  duration: number;
  request_id: string | null;
  word_timestamps: WordTimestamp[] | null;
}

export interface CreateVideoResult {
  video_id: string;
  status: VideoStatus;
  output_format: "mp4" | "webm";
}

export interface VideoDetail {
  id: string;
  title: string | null;
  status: VideoStatus;
  created_at: number | null;
  completed_at: number | null;
  video_url: string | null;
  thumbnail_url: string | null;
  gif_url: string | null;
  captioned_video_url: string | null;
  subtitle_url: string | null;
  duration: number | null;
  folder_id: string | null;
  video_page_url: string | null;
  output_language: string | null;
  failure_code: string | null;
  failure_message: string | null;
}

export interface HeyGenErrorBody {
  code: string;
  message: string;
  param: string | null;
  doc_url: string | null;
}

export class HeyGenError extends Error {
  status: number;
  body: HeyGenErrorBody | null;
  constructor(status: number, body: HeyGenErrorBody | null, message: string) {
    super(message);
    this.name = "HeyGenError";
    this.status = status;
    this.body = body;
  }
}

// ----- Core fetch wrapper -----

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
  // For non-JSON bodies (e.g. audio file upload to /v3/assets)
  rawBody?: BodyInit;
  rawContentType?: string;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(path, BASE_URL);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    "X-Api-Key": env.HEYGEN_API_KEY,
    Accept: "application/json",
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    if (opts.rawContentType) headers["Content-Type"] = opts.rawContentType;
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }

  const resp = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers,
    body,
  });

  const text = await resp.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      /* keep null */
    }
  }

  if (!resp.ok) {
    const errorBody =
      json && typeof json === "object" && "error" in json
        ? (json as { error: HeyGenErrorBody }).error
        : null;
    const msg = errorBody?.message ?? `HeyGen ${resp.status} ${resp.statusText}`;
    throw new HeyGenError(resp.status, errorBody, msg);
  }

  if (json && typeof json === "object" && "data" in json) {
    return (json as { data: T }).data;
  }
  return json as T;
}

// ----- Public client functions -----

export async function listAvatarLooks(opts?: {
  limit?: number;
  token?: string;
  avatar_type?: AvatarType;
}): Promise<PaginatedList<AvatarLook>> {
  const url = new URL("/v3/avatars/looks", BASE_URL);
  if (opts?.limit) url.searchParams.set("limit", String(opts.limit));
  if (opts?.token) url.searchParams.set("token", opts.token);
  if (opts?.avatar_type) url.searchParams.set("avatar_type", opts.avatar_type);

  const resp = await fetch(url.toString(), {
    headers: { "X-Api-Key": env.HEYGEN_API_KEY, Accept: "application/json" },
  });
  const text = await resp.text();
  const json = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    throw new HeyGenError(resp.status, json?.error ?? null, json?.error?.message ?? "List looks failed");
  }
  // Endpoint returns { data: AvatarLook[], has_more, next_token }
  return json as PaginatedList<AvatarLook>;
}

export async function getAvatarLook(id: string): Promise<AvatarLook> {
  return request<AvatarLook>(`/v3/avatars/looks/${id}`);
}

export async function listVoices(opts?: {
  engine?: VoiceEngine;
  language?: string;
  gender?: string;
  limit?: number;
  token?: string;
}): Promise<PaginatedList<Voice>> {
  const url = new URL("/v3/voices", BASE_URL);
  if (opts?.engine) url.searchParams.set("engine", opts.engine);
  if (opts?.language) url.searchParams.set("language", opts.language);
  if (opts?.gender) url.searchParams.set("gender", opts.gender);
  if (opts?.limit) url.searchParams.set("limit", String(opts.limit));
  if (opts?.token) url.searchParams.set("token", opts.token);

  const resp = await fetch(url.toString(), {
    headers: { "X-Api-Key": env.HEYGEN_API_KEY, Accept: "application/json" },
  });
  const text = await resp.text();
  const json = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    throw new HeyGenError(resp.status, json?.error ?? null, json?.error?.message ?? "List voices failed");
  }
  return json as PaginatedList<Voice>;
}

export async function generateSpeech(opts: {
  text: string;
  voiceId: string;
  inputType?: "text" | "ssml";
  speed?: number;
  language?: string;
  locale?: string;
}): Promise<SpeechResult> {
  return request<SpeechResult>("/v3/voices/speech", {
    method: "POST",
    body: {
      text: opts.text,
      voice_id: opts.voiceId,
      input_type: opts.inputType ?? "text",
      speed: opts.speed ?? 1,
      language: opts.language,
      locale: opts.locale,
    },
  });
}

/**
 * Download the audio from /v3/voices/speech and upload it to /v3/assets so we
 * get a stable audio_asset_id. Pass that asset_id to createVideo, not the raw
 * audio_url — that URL is short-TTL and HeyGen's render pipeline can fail to
 * fetch it in time (gateway_timeout).
 *
 * /v3/assets expects multipart/form-data with a "file" field.
 */
export async function uploadAudioAsset(audioUrl: string): Promise<{ asset_id: string }> {
  const audioResp = await fetch(audioUrl);
  if (!audioResp.ok) {
    throw new HeyGenError(audioResp.status, null, `Failed to download audio from ${audioUrl}`);
  }
  const blob = await audioResp.blob();
  const ext = audioUrl.match(/\.(wav|mp3|m4a|ogg)(?:$|\?)/i)?.[1]?.toLowerCase() ?? "wav";

  const form = new FormData();
  form.append("file", blob, `speech.${ext}`);

  const resp = await fetch(`${BASE_URL}/v3/assets`, {
    method: "POST",
    headers: {
      "X-Api-Key": env.HEYGEN_API_KEY,
      Accept: "application/json",
      // Do NOT set Content-Type — FormData sets multipart boundary automatically.
    },
    body: form,
  });
  const text = await resp.text();
  const json = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    throw new HeyGenError(
      resp.status,
      json?.error ?? null,
      json?.error?.message ?? `Asset upload failed (${resp.status})`
    );
  }
  return (json?.data ?? json) as { asset_id: string };
}

export interface CreateVideoInput {
  avatarId: string;
  // Provide exactly one of these:
  script?: string;
  audioUrl?: string;
  audioAssetId?: string;
  // For script mode:
  voiceId?: string;

  engine?: AvatarEngine; // default avatar_v
  resolution?: "4k" | "1080p" | "720p";
  aspectRatio?: "16:9" | "9:16";
  fit?: "contain" | "cover";
  background?:
    | { type: "color"; value: string }
    | { type: "image"; url: string }
    | { type: "image"; asset_id: string };
  removeBackground?: boolean;
  title?: string;
  callbackUrl?: string;
  callbackId?: string;
}

export async function createVideo(input: CreateVideoInput): Promise<CreateVideoResult> {
  const audioSources = [input.script, input.audioUrl, input.audioAssetId].filter(Boolean);
  if (audioSources.length !== 1) {
    throw new Error(
      "createVideo: provide exactly one of script, audioUrl, or audioAssetId"
    );
  }

  const body: Record<string, unknown> = {
    type: "avatar",
    avatar_id: input.avatarId,
    engine: { type: input.engine ?? "avatar_v" },
    resolution: input.resolution ?? "1080p",
    aspect_ratio: input.aspectRatio ?? "16:9",
  };

  if (input.script) {
    body.script = input.script;
    if (input.voiceId) body.voice_id = input.voiceId;
  } else if (input.audioUrl) {
    body.audio_url = input.audioUrl;
  } else if (input.audioAssetId) {
    body.audio_asset_id = input.audioAssetId;
  }

  if (input.fit) body.fit = input.fit;
  if (input.background) body.background = input.background;
  if (input.removeBackground !== undefined) body.remove_background = input.removeBackground;
  if (input.title) body.title = input.title;
  if (input.callbackUrl) body.callback_url = input.callbackUrl;
  if (input.callbackId) body.callback_id = input.callbackId;

  return request<CreateVideoResult>("/v3/videos", {
    method: "POST",
    body,
    idempotencyKey: input.callbackId, // safe re-tries
  });
}

export async function getVideo(videoId: string): Promise<VideoDetail> {
  return request<VideoDetail>(`/v3/videos/${videoId}`);
}

/**
 * Poll /v3/videos/{id} until completed or failed.
 * Use this in scripts/tests only — production should rely on webhooks.
 */
export async function pollVideo(
  videoId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<VideoDetail> {
  const interval = opts.intervalMs ?? 10_000;
  const timeout = opts.timeoutMs ?? 15 * 60 * 1000;
  const started = Date.now();
  while (true) {
    const v = await getVideo(videoId);
    if (v.status === "completed" || v.status === "failed") return v;
    if (Date.now() - started > timeout) {
      throw new Error(`pollVideo: timed out after ${timeout}ms (still ${v.status})`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
