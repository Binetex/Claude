import "server-only";

/**
 * Клиент Airwallex Payments API. Эндпоинты и статусы — строго по официальной документации:
 *  - авторизация: POST /api/v1/authentication/login, заголовки x-client-id + x-api-key →
 *    { token, expires_at }; токен живёт ~30 минут, переиспользуется до истечения;
 *  - получить платёж: GET /api/v1/pa/payment_intents/{id}, Authorization: Bearer <token>.
 *
 * Безопасность: ни токен, ни credentials НЕ логируются и наружу не отдаются. Наружу — только
 * безопасные коды/статусы.
 */
const BASE = { prod: "https://api.airwallex.com", demo: "https://api-demo.airwallex.com" } as const;
const TIMEOUT_MS = 12_000;

export type AirwallexEnv = "prod" | "demo";

export type AirwallexCreds = { clientId: string; apiKey: string; env: AirwallexEnv };

/** Статусы payment_intent по документации Airwallex. UNKNOWN — на случай нового значения. */
export type AirwallexIntentStatus =
  | "REQUIRES_PAYMENT_METHOD"
  | "REQUIRES_CUSTOMER_ACTION"
  | "REQUIRES_CAPTURE"
  | "PENDING"
  | "PENDING_REVIEW"
  | "SUCCEEDED"
  | "CANCELLED"
  | "UNKNOWN";

export type PaymentIntentResult =
  | { ok: true; found: true; status: AirwallexIntentStatus; rawStatus: string; latestAttemptStatus: string | null; capturedAmount: number | null; amount: number | null; currency: string | null }
  | { ok: true; found: false } // 404 — intent не найден
  | { ok: false; retryable: boolean; code: string; reauth?: boolean };

export type VerifyResult = { ok: true; accountName: string | null } | { ok: false; code: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Известные статусы приводим к типу, незнакомое → UNKNOWN (не гадаем). */
function normalizeStatus(raw: string): AirwallexIntentStatus {
  const known: AirwallexIntentStatus[] = [
    "REQUIRES_PAYMENT_METHOD", "REQUIRES_CUSTOMER_ACTION", "REQUIRES_CAPTURE",
    "PENDING", "PENDING_REVIEW", "SUCCEEDED", "CANCELLED",
  ];
  const up = (raw ?? "").toUpperCase();
  return (known as string[]).includes(up) ? (up as AirwallexIntentStatus) : "UNKNOWN";
}

export class AirwallexClient {
  private token: string | null = null;
  private tokenExpiresAt = 0; // ms epoch
  constructor(private readonly creds: AirwallexCreds) {}

  private base() {
    return BASE[this.creds.env] ?? BASE.prod;
  }

  private async fetchJson(path: string, init: RequestInit): Promise<{ status: number; json: unknown | null; networkError?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${this.base()}${path}`, { ...init, signal: controller.signal });
      const json = await r.json().catch(() => null);
      return { status: r.status, json };
    } catch (err) {
      return { status: 0, json: null, networkError: err instanceof Error ? err.name : "network_error" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Авторизация. Токен кэшируется до истечения — повторно не логинимся без нужды. */
  private async ensureToken(force = false): Promise<{ ok: true } | { ok: false; code: string }> {
    if (!force && this.token && Date.now() < this.tokenExpiresAt - 60_000) return { ok: true };
    const { status, json, networkError } = await this.fetchJson("/api/v1/authentication/login", {
      method: "POST",
      headers: { "x-client-id": this.creds.clientId, "x-api-key": this.creds.apiKey, "content-type": "application/json" },
    });
    if (networkError) return { ok: false, code: `network:${networkError}` };
    if (status === 401 || status === 403) return { ok: false, code: "unauthorized" };
    const token = (json as { token?: string } | null)?.token;
    const exp = (json as { expires_at?: string } | null)?.expires_at;
    if (status !== 201 && status !== 200) return { ok: false, code: `http_${status}` };
    if (!token) return { ok: false, code: "no_token" };
    this.token = token;
    // expires_at — ISO; при отсутствии/битом значении держим консервативные 25 минут.
    const parsed = exp ? Date.parse(exp) : NaN;
    this.tokenExpiresAt = Number.isFinite(parsed) ? parsed : Date.now() + 25 * 60_000;
    return { ok: true };
  }

  /** Проверка подключения для UI: успешная авторизация = связь есть. */
  async verify(): Promise<VerifyResult> {
    const t = await this.ensureToken(true);
    if (!t.ok) return { ok: false, code: t.code };
    return { ok: true, accountName: null };
  }

  /**
   * Получить payment_intent. 401 → одна повторная авторизация; 429 → backoff; 404 → not found.
   * Возвращает нормализованный статус + сырой + статус последней попытки (для «провала»).
   */
  async getPaymentIntent(id: string, attempt = 0): Promise<PaymentIntentResult> {
    const t = await this.ensureToken();
    if (!t.ok) return { ok: false, retryable: t.code.startsWith("network"), code: t.code, reauth: t.code === "unauthorized" };

    const { status, json, networkError } = await this.fetchJson(`/api/v1/pa/payment_intents/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
    });

    if (networkError) return { ok: false, retryable: true, code: `network:${networkError}` };
    if (status === 404) return { ok: true, found: false };
    if (status === 401 && attempt === 0) {
      // Токен протух между login и запросом — один re-auth и повтор.
      await this.ensureToken(true);
      return this.getPaymentIntent(id, attempt + 1);
    }
    if (status === 401 || status === 403) return { ok: false, retryable: false, code: "unauthorized", reauth: true };
    if (status === 429) {
      if (attempt < 2) { await sleep((attempt + 1) * 1000); return this.getPaymentIntent(id, attempt + 1); }
      return { ok: false, retryable: true, code: "rate_limited" };
    }
    if (status >= 500) return { ok: false, retryable: true, code: `http_${status}` };
    if (status !== 200 || !json) return { ok: false, retryable: false, code: `http_${status}` };

    const o = json as {
      status?: string;
      amount?: number;
      currency?: string;
      captured_amount?: number;
      latest_payment_attempt?: { status?: string } | null;
    };
    const rawStatus = String(o.status ?? "");
    return {
      ok: true,
      found: true,
      status: normalizeStatus(rawStatus),
      rawStatus,
      latestAttemptStatus: o.latest_payment_attempt?.status ?? null,
      capturedAmount: typeof o.captured_amount === "number" ? o.captured_amount : null,
      amount: typeof o.amount === "number" ? o.amount : null,
      currency: o.currency ?? null,
    };
  }
}
