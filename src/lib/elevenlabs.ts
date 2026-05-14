import "server-only";
import { env } from "./env";

/**
 * ElevenLabs Scribe v1 — speech-to-text with word-level timestamps.
 * https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 *
 * We use this for post-render transcription: download HeyGen MP4 → extract
 * audio → send to scribe → use the word timestamps to drive HyperFrame overlays.
 */

const BASE_URL = "https://api.elevenlabs.io";

export interface ElevenLabsWord {
  text: string;
  start: number; // seconds
  end: number;   // seconds
  type: "word" | "spacing" | "audio_event";
  speaker_id?: string;
  logprob?: number;
}

export interface TranscriptionResult {
  language_code: string;
  language_probability: number;
  text: string;
  words: ElevenLabsWord[];
}

export class ElevenLabsError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "ElevenLabsError";
    this.status = status;
    this.body = body;
  }
}

/**
 * POST /v1/speech-to-text
 *
 * Send an audio buffer (WAV/MP3/M4A/FLAC/OGG) and get back word-level
 * timestamps. `audioBlob` content-type should be set when known — defaults to
 * audio/mpeg.
 */
export async function transcribeAudio(opts: {
  audio: ArrayBuffer | Blob;
  filename?: string;
  contentType?: string;
  modelId?: string;
  languageCode?: string;
  numSpeakers?: number;
  timestampsGranularity?: "word" | "character" | "none";
  tagAudioEvents?: boolean;
}): Promise<TranscriptionResult> {
  const blob =
    opts.audio instanceof Blob
      ? opts.audio
      : new Blob([opts.audio], { type: opts.contentType ?? "audio/mpeg" });

  const form = new FormData();
  form.append("file", blob, opts.filename ?? "speech.mp3");
  form.append("model_id", opts.modelId ?? "scribe_v1");
  if (opts.languageCode) form.append("language_code", opts.languageCode);
  if (opts.numSpeakers !== undefined)
    form.append("num_speakers", String(opts.numSpeakers));
  if (opts.timestampsGranularity)
    form.append("timestamps_granularity", opts.timestampsGranularity);
  if (opts.tagAudioEvents !== undefined)
    form.append("tag_audio_events", String(opts.tagAudioEvents));

  const resp = await fetch(`${BASE_URL}/v1/speech-to-text`, {
    method: "POST",
    headers: {
      "xi-api-key": env.ELEVENLABS_API_KEY,
      Accept: "application/json",
    },
    body: form,
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
    const message =
      json && typeof json === "object" && "detail" in json
        ? JSON.stringify((json as { detail: unknown }).detail)
        : `ElevenLabs ${resp.status} ${resp.statusText}`;
    throw new ElevenLabsError(resp.status, json, message);
  }

  return json as TranscriptionResult;
}
