import "server-only";
/**
 * HTTP-клиент QUO (ex-OpenPhone), base https://api.openphone.com/v1. Auth: заголовок
 * `Authorization: <API_KEY>` (СЫРОЙ ключ, НЕ Bearer — подтверждено докой). Ошибки → типизированные
 * QuoApiError (401/403/404/429/5xx). Ретрай ТОЛЬКО для 429 и временных 5xx (+ сетевые), с backoff
 * и уважением Retry-After. `fetchImpl`/`sleep` инъектируются в тестах (без реальных вызовов).
 * Ключи/тела не логируются.
 */
import { quoErrorFromStatus, quoNetworkError, QuoApiError } from "./errors";
import type { QuoSendResult, QuoMessageObject, QuoCallObject, QuoRecordingObject, QuoTranscriptObject, QuoSummaryObject } from "./types";

export type QuoClientConfig = {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Максимум ПОВТОРОВ (сверх первой попытки) для ретраибельных ошибок. По умолчанию 3. */
  maxRetries?: number;
  /** Инъекция сна между ретраями (тесты передают no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** База backoff, мс. */
  baseDelayMs?: number;
};

type Query = Record<string, string | number | undefined>;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ответы QUO оборачивают полезную нагрузку в `data`. Разворачиваем безопасно. */
function unwrap<T>(json: unknown): T {
  if (json && typeof json === "object" && "data" in (json as Record<string, unknown>)) {
    return (json as { data: T }).data;
  }
  return json as T;
}

export interface QuoClient {
  sendMessage(input: { content: string; from: string; to: string[]; userId?: string }): Promise<QuoSendResult>;
  getMessage(id: string): Promise<QuoMessageObject>;
  listMessages(params: { phoneNumberId: string; participants: string[]; maxResults: number; createdAfter?: string; pageToken?: string }): Promise<{ data: QuoMessageObject[]; nextPageToken: string | null }>;
  getCall(id: string): Promise<QuoCallObject>;
  listCalls(params: { phoneNumberId: string; participants: string[]; maxResults: number; createdAfter?: string; pageToken?: string }): Promise<{ data: QuoCallObject[]; nextPageToken: string | null }>;
  getCallRecordings(callId: string): Promise<QuoRecordingObject[]>;
  getCallTranscript(callId: string): Promise<QuoTranscriptObject | null>;
  getCallSummary(callId: string): Promise<QuoSummaryObject | null>;
  listPhoneNumbers(): Promise<{ id: string; number?: string }[]>;
}

export function createQuoClient(cfg: QuoClientConfig): QuoClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const maxRetries = cfg.maxRetries ?? 3;
  const sleep = cfg.sleep ?? defaultSleep;
  const baseDelayMs = cfg.baseDelayMs ?? 300;

  function buildUrl(path: string, query?: Query): string {
    const url = new URL(`${cfg.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && String(v) !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async function request(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<unknown> {
    const url = buildUrl(path, opts.query);
    let attempt = 0;
    // attempt 0 = первая попытка; далее до maxRetries повторов для ретраибельных ошибок.
    for (;;) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method,
          headers: { Authorization: cfg.apiKey, "Content-Type": "application/json", Accept: "application/json" },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        const e = quoNetworkError(err instanceof Error ? err.name : "fetch_failed");
        if (attempt < maxRetries) { await sleep(backoff(baseDelayMs, attempt)); attempt++; continue; }
        throw e;
      }

      if (res.ok) {
        if (res.status === 204) return null;
        const text = await res.text();
        return text ? safeParse(text) : null;
      }

      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const safeCode = await safeErrorCode(res);
      const apiErr = quoErrorFromStatus(res.status, retryAfter, safeCode);
      if (apiErr.retryable && attempt < maxRetries) {
        const wait = retryAfter != null ? retryAfter * 1000 : backoff(baseDelayMs, attempt);
        await sleep(wait);
        attempt++;
        continue;
      }
      throw apiErr;
    }
  }

  return {
    async sendMessage(input) {
      const json = await request("POST", "/messages", { body: { content: input.content, from: input.from, to: input.to, ...(input.userId ? { userId: input.userId } : {}) } });
      const d = unwrap<{ id: string; status: string; conversationId?: string | null; from?: string | null; to?: string[] }>(json);
      return { id: d.id, status: d.status, conversationId: d.conversationId ?? null, from: d.from ?? null, to: d.to ?? input.to };
    },
    async getMessage(id) {
      return unwrap<QuoMessageObject>(await request("GET", `/messages/${encodeURIComponent(id)}`));
    },
    async listMessages(params) {
      const json = (await request("GET", "/messages", { query: { phoneNumberId: params.phoneNumberId, participants: params.participants.join(","), maxResults: params.maxResults, createdAfter: params.createdAfter, pageToken: params.pageToken } })) as { data?: QuoMessageObject[]; nextPageToken?: string | null };
      return { data: json?.data ?? [], nextPageToken: json?.nextPageToken ?? null };
    },
    async getCall(id) {
      return unwrap<QuoCallObject>(await request("GET", `/calls/${encodeURIComponent(id)}`));
    },
    async listCalls(params) {
      const json = (await request("GET", "/calls", { query: { phoneNumberId: params.phoneNumberId, participants: params.participants.join(","), maxResults: params.maxResults, createdAfter: params.createdAfter, pageToken: params.pageToken } })) as { data?: QuoCallObject[]; nextPageToken?: string | null };
      return { data: json?.data ?? [], nextPageToken: json?.nextPageToken ?? null };
    },
    async getCallRecordings(callId) {
      const json = (await request("GET", `/call-recordings/${encodeURIComponent(callId)}`)) as { data?: QuoRecordingObject[] } | QuoRecordingObject[];
      return Array.isArray(json) ? json : json?.data ?? [];
    },
    async getCallTranscript(callId) {
      // Business/Scale only: 402/403 → null (не ломаем обработку).
      try {
        return unwrap<QuoTranscriptObject>(await request("GET", `/call-transcripts/${encodeURIComponent(callId)}`));
      } catch (err) {
        if (err instanceof QuoApiError && (err.kind === "forbidden" || err.kind === "not_found" || err.status === 402)) return null;
        throw err;
      }
    },
    async getCallSummary(callId) {
      try {
        return unwrap<QuoSummaryObject>(await request("GET", `/call-summaries/${encodeURIComponent(callId)}`));
      } catch (err) {
        if (err instanceof QuoApiError && (err.kind === "forbidden" || err.kind === "not_found" || err.status === 402)) return null;
        throw err;
      }
    },
    async listPhoneNumbers() {
      const json = (await request("GET", "/phone-numbers")) as { data?: { id: string; number?: string }[] } | { id: string; number?: string }[];
      return Array.isArray(json) ? json : json?.data ?? [];
    },
  };
}

function backoff(base: number, attempt: number): number {
  return Math.min(base * 2 ** attempt, 5000) + Math.floor(Math.random() * 50);
}

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Достаёт безопасный код ошибки из тела (без утечки PII/секретов). */
async function safeErrorCode(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    const j = JSON.parse(text) as { code?: string; error?: { code?: string } };
    const code = j.code ?? j.error?.code ?? null;
    return typeof code === "string" ? code.slice(0, 40) : null;
  } catch {
    return null;
  }
}
