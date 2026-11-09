import type { RouteDecision } from "./types";

export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export function llmSettings(): LlmSettings | null {
  const apiKey = process.env.ROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (process.env.ROUTER_BASE_URL?.trim() || "http://localhost:20128/v1").replace(/\/+$/, "");
  const model = process.env.ROUTER_MODEL?.trim() || "cc/claude-haiku-4-5-20251001";
  // Cloud routers with reasoning models routinely take 10-30s per plan call.
  const timeoutMs = Number(process.env.ROUTER_TIMEOUT_MS ?? 30000);
  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000,
  };
}

export function isLlmEnabled(): boolean {
  return llmSettings() !== null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class LlmError extends Error {
  readonly retryable: boolean;
  readonly raw?: string;

  constructor(message: string, retryable: boolean, raw?: string) {
    super(message);
    this.name = "LlmError";
    this.retryable = retryable;
    this.raw = raw;
  }
}

export function snippet(raw: string | undefined, max = 180): string {
  if (!raw) return "";
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

/**
 * Minimal OpenAI-compatible client (9router, OpenRouter, OpenAI, Ollama...).
 * No SDK so the demo keeps zero provider dependencies.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: { json?: boolean; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const settings = llmSettings();
  if (!settings) {
    throw new LlmError("ROUTER_API_KEY chưa được cấu hình.", false);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: 0,
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
        max_tokens: options.maxTokens ?? 600,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const body = await response.text().catch(() => "");
      throw new LlmError(
        `LLM HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
        retryable,
      );
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const choice = payload.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (!content) throw new LlmError("LLM trả về nội dung rỗng.", true);
    if (choice?.finish_reason === "length") {
      throw new LlmError(
        `LLM bị cắt do max_tokens=${options.maxTokens ?? 600} (JSON dở dang).`,
        true,
        content,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new LlmError(`LLM timeout sau ${settings.timeoutMs}ms.`, true);
    }
    throw new LlmError(`Không gọi được LLM: ${(error as Error).message}`, true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

/**
 * JSON repair for real-world model output:
 * - prose / ```json fences around the object
 * - trailing commas
 * - raw newlines inside strings (Vietnamese multi-line answers)
 * - truncated output (close open string + brackets)
 * - single-quoted pseudo-JSON when the model used no double quotes at all
 */
function stripFences(raw: string): string {
  const fenced = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return (fenced?.[1] ?? raw).replace(/^\uFEFF/, "").trim();
}

function scanObject(text: string, start: number): { json: string; truncated: boolean } {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let out = "";

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      out += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth -= 1;
      out += ch;
      if (depth === 0) return { json: out, truncated: false };
      continue;
    }
    out += ch;
  }

  return { json: out, truncated: true };
}

function closeTruncated(json: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of json) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }

  let out = json;
  if (inString) out += '"';
  // A truncated object usually ends mid-value ("key": ), so drop the dangling key/value.
  out = out.replace(/,\s*$/, "");
  out = out.replace(/,?\s*"[^"]*"\s*:\s*$/, "");
  while (stack.length > 0) {
    const closer = stack.pop()!;
    // Drop a trailing comma so `[...]` / `{...}` stays valid.
    out = out.replace(/,\s*$/, "");
    out += closer;
  }
  return out;
}

function stripTrailingCommas(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let next = i + 1;
      while (next < json.length && /\s/.test(json[next])) next += 1;
      if (json[next] === "}" || json[next] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function tryParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function parseCandidates(raw: string): string[] {
  const text = stripFences(raw);
  const start = text.indexOf("{");
  if (start < 0) return [];

  const { json, truncated } = scanObject(text, start);
  const candidates = new Set<string>();
  candidates.add(truncated ? closeTruncated(json) : json);
  candidates.add(stripTrailingCommas(truncated ? closeTruncated(json) : json));

  // Model emitted single quotes instead of JSON double quotes.
  if (!text.includes('"') && text.includes("'")) {
    const swapped = stripTrailingCommas(closeTruncated(json)).replace(/'/g, '"');
    candidates.add(swapped);
  }
  return [...candidates];
}

export function parseJsonObject<T>(raw: string): T {
  const candidates = parseCandidates(raw);
  if (candidates.length === 0) {
    throw new LlmError("LLM không trả về JSON object.", true, raw);
  }
  for (const candidate of candidates) {
    const parsed = tryParse<T>(candidate);
    if (parsed !== null) return parsed;
  }
  throw new LlmError("JSON của LLM không parse được.", true, raw);
}

/**
 * JSON call with one repair round-trip. Covers the three real failure modes:
 * truncated output (finish_reason=length), unparseable JSON, and JSON that
 * parses but fails domain validation — each retried once with specific feedback.
 */
export async function chatJsonValidated<T>(
  messages: ChatMessage[],
  options: {
    maxTokens?: number;
    signal?: AbortSignal;
    label?: string;
    validate?: (value: T) => T;
  } = {},
): Promise<T> {
  const maxTokens = options.maxTokens ?? 600;
  const validate = options.validate ?? ((value: T) => value);
  const label = options.label ?? "json";

  let firstRaw = "";
  let problem = "";

  try {
    const content = await chatCompletion(messages, { json: true, maxTokens, signal: options.signal });
    firstRaw = content;
    return validate(parseJsonObject<T>(content));
  } catch (error) {
    if (!(error instanceof LlmError) || !error.retryable) throw error;
    problem = error.message;
    firstRaw = error.raw ?? firstRaw;
  }

  console.warn(`[llm] ${label} failed (${problem}), retrying. raw=${snippet(firstRaw, 240)}`);

  const repaired = await chatCompletion(
    [
      ...messages,
      { role: "assistant", content: firstRaw || "(empty)" },
      {
        role: "user",
        content: [
          `Output trước lỗi: ${problem}`,
          "In lại CHỈ một JSON object hợp lệ, không markdown, không giải thích.",
          "Không dùng ký tự newline thật trong string. Không trailing comma.",
          "Nếu bị cắt do giới hạn token, rút gọn chữ mô tả lại.",
        ].join("\n"),
      },
    ],
    { json: true, maxTokens: Math.min(maxTokens * 2, 2400), signal: options.signal },
  );

  try {
    return validate(parseJsonObject<T>(repaired));
  } catch (error) {
    const detail = error instanceof LlmError ? error.message : String(error);
    throw new LlmError(`${problem} — đã thử sửa 1 lần nhưng vẫn lỗi (${detail})`, false, repaired);
  }
}

export const ROUTE_SCHEMA_HINT = `Trả JSON đúng shape:
{
  "intent": "order_status" | "refund" | "product" | "faq" | "human_handoff" | "smalltalk" | "unknown",
  "confidence": number,           // 0..1
  "orderId": string | null,       // chỉ khi câu hỏi nhắc đơn, ví dụ "1002"
  "productTerm": string | null,   // tên/SKU/từ khoá sản phẩm
  "rationale": string[]           // tối đa 3 lý do ngắn
}`;

export function normalizeDecision(
  raw: Partial<RouteDecision> & { rationale?: string[] },
  fallback: RouteDecision,
): RouteDecision {
  const intents = [
    "order_status",
    "refund",
    "product",
    "faq",
    "human_handoff",
    "smalltalk",
    "unknown",
  ] as const;
  const intent = intents.includes(raw.intent as (typeof intents)[number])
    ? (raw.intent as RouteDecision["intent"])
    : fallback.intent;
  const confidenceRaw = typeof raw.confidence === "number" ? raw.confidence : fallback.confidence;
  const confidence = Math.min(0.99, Math.max(0, Math.round(confidenceRaw * 100) / 100));
  const orderIdRaw = typeof raw.orderId === "string" ? raw.orderId.replace(/[^\d]/g, "") : "";
  const rationale = Array.isArray(raw.rationale)
    ? raw.rationale.filter((line): line is string => typeof line === "string").slice(0, 3)
    : [];

  return {
    ...fallback,
    engine: "llm",
    intent,
    confidence,
    orderId: orderIdRaw || fallback.orderId,
    productTerm:
      typeof raw.productTerm === "string" && raw.productTerm.trim()
        ? raw.productTerm.trim()
        : fallback.productTerm,
    rationale: rationale.length > 0 ? ["LLM:", ...rationale] : ["LLM: phân loại theo ngữ nghĩa."],
  };
}
