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
  | { ok: true; found: true; status: AirwallexIntentStatus; rawStatus: string; latestAttemptStatus: string | null; latestAttemptId: string | null; capturedAmount: number | null; amount: number | null; currency: string | null }
  | { ok: true; found: false } // 404 — intent не найден
  | { ok: false; retryable: boolean; code: string; reauth?: boolean };

export type VerifyResult = { ok: true; accountName: string | null } | { ok: false; code: string };

/** Возврат по платежу. Суммы у Airwallex в единицах валюты (доллары), а не в центах. */
export type AirwallexRefund = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  reason: string | null;
  createdAt: string | null;
};

export type ListRefundsResult =
  | { ok: true; refunds: AirwallexRefund[] }
  | { ok: false; retryable: boolean; code: string };

/**
 * Ссылка на оплату. Поля — с живого ответа Airwallex 24.09.2026 (GET /pa/payment_links).
 * Налога среди них НЕТ и в запросе создания тоже: Airwallex сумму не пересчитывает, сколько
 * передали — столько и спишет.
 */
export type AirwallexPaymentLink = {
  id: string;
  url: string;
  title: string;
  amount: number | null;
  currency: string;
  status: string;
  active: boolean;
  createdAt: string | null;
  expiresAt: string | null;
};

export type CreatePaymentLinkResult =
  | { ok: true; link: AirwallexPaymentLink }
  | { ok: false; retryable: boolean; code: string; message: string | null };

export type ListPaymentLinksResult =
  | { ok: true; links: AirwallexPaymentLink[] }
  | { ok: false; retryable: boolean; code: string };

export type CreateRefundResult =
  | { ok: true; refund: AirwallexRefund }
  | { ok: false; retryable: boolean; code: string; message: string | null };

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

/** Строка ответа Airwallex → наша ссылка. Без id и url показывать нечего — такую пропускаем. */
function toPaymentLink(raw: unknown): AirwallexPaymentLink | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  const url = typeof r.url === "string" ? r.url : null;
  if (!id || !url) return null;
  return {
    id,
    url,
    title: typeof r.title === "string" ? r.title : "",
    amount: typeof r.amount === "number" ? r.amount : null,
    currency: typeof r.currency === "string" ? r.currency : "USD",
    status: typeof r.status === "string" ? r.status : "UNKNOWN",
    active: r.active !== false,
    createdAt: typeof r.created_at === "string" ? r.created_at : null,
    expiresAt: typeof r.expires_at === "string" ? r.expires_at : null,
  };
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

  /** Разбор объекта возврата Airwallex в наш вид. */
  private static toRefund(o: Record<string, unknown>): AirwallexRefund {
    return {
      id: String(o.id ?? ""),
      status: String(o.status ?? ""),
      amount: typeof o.amount === "number" ? o.amount : 0,
      currency: String(o.currency ?? ""),
      reason: typeof o.reason === "string" ? o.reason : null,
      createdAt: typeof o.created_at === "string" ? o.created_at : null,
    };
  }

  /**
   * Возвраты по платежу. Нужны, чтобы показать владельцу, сколько уже возвращено, и не дать
   * вернуть больше оплаченного. Берём их у Airwallex, а не из своей таблицы: возврат могли
   * сделать и мимо нас — из кабинета Airwallex или из WooCommerce.
   */
  async listRefunds(paymentIntentId: string, attempt = 0): Promise<ListRefundsResult> {
    const t = await this.ensureToken();
    if (!t.ok) return { ok: false, retryable: t.code.startsWith("network"), code: t.code };

    const q = `?payment_intent_id=${encodeURIComponent(paymentIntentId)}&page_num=0&page_size=50`;
    const { status, json, networkError } = await this.fetchJson(`/api/v1/pa/refunds${q}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
    });

    if (networkError) return { ok: false, retryable: true, code: `network:${networkError}` };
    if (status === 401 && attempt === 0) {
      await this.ensureToken(true);
      return this.listRefunds(paymentIntentId, attempt + 1);
    }
    if (status === 401 || status === 403) return { ok: false, retryable: false, code: "unauthorized" };
    if (status === 429) {
      if (attempt < 2) { await sleep((attempt + 1) * 1000); return this.listRefunds(paymentIntentId, attempt + 1); }
      return { ok: false, retryable: true, code: "rate_limited" };
    }
    if (status >= 500) return { ok: false, retryable: true, code: `http_${status}` };
    if (status !== 200 || !json) return { ok: false, retryable: false, code: `http_${status}` };

    const items = (json as { items?: Record<string, unknown>[] }).items ?? [];
    return { ok: true, refunds: items.map((i) => AirwallexClient.toRefund(i)) };
  }

  /**
   * СОЗДАНИЕ ВОЗВРАТА — единственный метод этого клиента, который двигает деньги.
   *
   * `requestId` обязателен и задаётся вызывающим: это ключ идемпотентности Airwallex. Один и
   * тот же ключ не создаст второй возврат, поэтому повторная отправка формы, ретрай сети или
   * двойной клик не вернут деньги дважды.
   *
   * Повторов здесь НЕТ намеренно — ни на 429, ни на 5xx, ни на разрыв сети. Ответ мог не
   * дойти уже после того, как возврат создан; молча повторять денежную операцию нельзя.
   * Владельцу возвращается честное «неизвестно», и он сверяется со списком возвратов.
   */
  async createRefund(input: {
    paymentIntentId: string;
    amount: number;
    currency: string;
    reason: string;
    requestId: string;
  }): Promise<CreateRefundResult> {
    const t = await this.ensureToken();
    if (!t.ok) return { ok: false, retryable: false, code: t.code, message: null };

    const { status, json, networkError } = await this.fetchJson("/api/v1/pa/refunds/create", {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        request_id: input.requestId,
        payment_intent_id: input.paymentIntentId,
        amount: input.amount,
        currency: input.currency,
        reason: input.reason,
      }),
    });

    // Сеть оборвалась — возврат МОГ пройти. Не повторяем и говорим об этом прямо.
    if (networkError) return { ok: false, retryable: false, code: "network_unknown", message: null };
    if (status === 401 || status === 403) return { ok: false, retryable: false, code: "unauthorized", message: null };
    if (status === 201 || status === 200) {
      if (!json) return { ok: false, retryable: false, code: "empty_response", message: null };
      return { ok: true, refund: AirwallexClient.toRefund(json as Record<string, unknown>) };
    }

    const body = json as { code?: string; message?: string; source?: string } | null;
    return {
      ok: false,
      retryable: false,
      code: body?.code ? String(body.code) : `http_${status}`,
      message: body?.message ? String(body.message) : null,
    };
  }

  /**
   * Получить payment_intent. 401 → одна повторная авторизация; 429 → backoff; 404 → not found.
   * Возвращает нормализованный статус + сырой + статус последней попытки (для «провала»).
   */
  /**
   * Ссылка на оплату. Обязательные поля по ответу API: `title` и `reusable`; сумма должна быть
   * положительной, валюта — из их списка (проверено заведомо неверными запросами 24.09.2026,
   * ничего при этом не создавая).
   *
   * `reusable: false` — одноразовая: оплатили и ссылка закрылась. Так владелец и создавал все
   * свои 17 ссылок руками; многоразовая для «клиент просит счёт» означала бы, что по одной
   * ссылке можно заплатить дважды.
   */
  async createPaymentLink(input: { title: string; amountMajor: number; currency: string; description?: string | null }): Promise<CreatePaymentLinkResult> {
    const auth = await this.ensureToken();
    if (!auth.ok) return { ok: false, retryable: false, code: auth.code, message: null };
    const { status, json, networkError } = await this.fetchJson("/api/v1/pa/payment_links/create", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        reusable: false,
        amount: input.amountMajor,
        currency: input.currency,
        ...(input.description ? { description: input.description } : {}),
      }),
    });
    if (networkError) return { ok: false, retryable: true, code: `network:${networkError}`, message: null };
    if (status === 401 || status === 403) return { ok: false, retryable: false, code: "unauthorized", message: null };
    if (status >= 500) return { ok: false, retryable: true, code: `http_${status}`, message: null };
    if (status !== 200 && status !== 201) {
      // Текст валидации Airwallex («'amount' must be positive.») понятнее любой нашей догадки.
      const msg = (json as { message?: string } | null)?.message ?? null;
      return { ok: false, retryable: false, code: `http_${status}`, message: msg };
    }
    const link = toPaymentLink(json);
    if (!link) return { ok: false, retryable: false, code: "bad_response", message: null };
    return { ok: true, link };
  }

  /** Последние ссылки — читаем у Airwallex, своей таблицы не заводим: правда там, включая
   *  оплаты и ссылки, созданные мимо нас в их кабинете. */
  async listPaymentLinks(limit = 20): Promise<ListPaymentLinksResult> {
    const auth = await this.ensureToken();
    if (!auth.ok) return { ok: false, retryable: false, code: auth.code };
    const { status, json, networkError } = await this.fetchJson(`/api/v1/pa/payment_links?page_size=${limit}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (networkError) return { ok: false, retryable: true, code: `network:${networkError}` };
    if (status === 401 || status === 403) return { ok: false, retryable: false, code: "unauthorized" };
    if (status !== 200) return { ok: false, retryable: status >= 500, code: `http_${status}` };
    const items = (json as { items?: unknown[] } | null)?.items ?? [];
    return { ok: true, links: items.map(toPaymentLink).filter((l): l is AirwallexPaymentLink => l !== null) };
  }

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
      latest_payment_attempt?: { id?: string; status?: string } | null;
    };
    const rawStatus = String(o.status ?? "");
    return {
      ok: true,
      found: true,
      status: normalizeStatus(rawStatus),
      rawStatus,
      latestAttemptStatus: o.latest_payment_attempt?.status ?? null,
      latestAttemptId: o.latest_payment_attempt?.id ?? null,
      capturedAmount: typeof o.captured_amount === "number" ? o.captured_amount : null,
      amount: typeof o.amount === "number" ? o.amount : null,
      currency: o.currency ?? null,
    };
  }
}
