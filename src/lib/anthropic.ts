import "server-only";
import { env } from "./env";

/**
 * Anthropic Messages API client. Server-side only.
 *
 * https://docs.anthropic.com/en/api/messages
 *
 * Minimal surface: just createMessage(). We support cache_control on system
 * blocks so the script generator can cache the persona + rules + tone prompt
 * (stable across calls) and only re-pay tokens for the variable prospect data.
 */

const BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

export type ClaudeModel =
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001";

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface UserMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MessagesUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface MessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  usage: MessagesUsage;
}

export class AnthropicError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "AnthropicError";
    this.status = status;
    this.body = body;
  }
}

export interface CreateMessageOpts {
  model: ClaudeModel;
  maxTokens: number;
  system?: string | SystemBlock[];
  messages: UserMessage[];
  temperature?: number;
}

export async function createMessage(opts: CreateMessageOpts): Promise<MessagesResponse> {
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: opts.messages,
  };
  if (opts.system !== undefined) body.system = opts.system;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  const resp = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
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
      json && typeof json === "object" && "error" in json
        ? JSON.stringify((json as { error: unknown }).error)
        : `Anthropic ${resp.status} ${resp.statusText}`;
    throw new AnthropicError(resp.status, json, message);
  }

  return json as MessagesResponse;
}

/** Pulls the concatenated text from a Messages API response. */
export function extractText(resp: MessagesResponse): string {
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
