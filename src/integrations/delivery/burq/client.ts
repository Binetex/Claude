import "server-only";
/**
 * Burq HTTP-клиент: create/get/delete заказа. Фабрики real/mock + безопасная проверка ключа.
 * Реальный клиент рантайма собирается из СОХРАНЁННЫХ в БД credentials (settings.getBurqRuntimeClient),
 * а не из env; при выключенном BURQ_RUNTIME_ENABLED используется mock.
 *
 * Sandbox = тот же host (https://api.burqup.com/v2) + ТЕСТОВЫЙ ключ → test_mode=true.
 * Ключи НИКОГДА не логируются.
 */
import { randomUUID } from "node:crypto";
import type { BurqCreateOrderRequest, BurqOrder, BurqRawOrderResponse } from "./types";
import { normalizePodUrls, normalizeSignatureUrl } from "./podCapture";
import type { RouteQuotesResponse } from "./quotes";

export interface BurqClient {
  readonly mode: "real" | "mock";
  createDraft(req: BurqCreateOrderRequest, idempotencyKey: string): Promise<BurqOrder>;
  getOrder(id: string): Promise<BurqOrder>;
  /** DELETE — только НЕинициированный заказ (иначе Burq вернёт 400). */
  deleteOrder(id: string): Promise<void>;

  // ── Котировки: «есть ли курьеры на этот маршрут» ──
  // Котировки в v2 живут на МАРШРУТЕ, а не на заказе: путь order → route → quotes.
  // Ничего не диспатчит; Pick Provider / Dispatch мы не вызываем вовсе.
  /** Создаёт route из уже существующих заказов. */
  createRoute(orderIds: string[]): Promise<{ id: string }>;
  /** Запускает асинхронный расчёт котировок. Возвращает job id (нам он не нужен). */
  requestRouteQuotes(routeId: string): Promise<void>;
  /** Текущий снимок котировок: status PENDING → COMPLETE, data (пустой массив = никого нет). */
  listRouteQuotes(routeId: string): Promise<RouteQuotesResponse>;
  /** DELETE маршрута — убираем за собой, чтобы не копить мусор в аккаунте Burq. */
  deleteRoute(routeId: string): Promise<void>;
}

export class BurqApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null) {
    super(message);
    this.name = "BurqApiError";
  }
}

/** Нормализует сырой ответ Burq в плоский BurqOrder (статус — из latest_delivery). */
export function normalizeBurqOrder(raw: BurqRawOrderResponse): BurqOrder {
  const ld = raw.latest_delivery ?? null;
  return {
    id: raw.id,
    status: ld?.status ?? "request", // начальный статус неинициированного заказа
    checkoutUrl: raw.checkout_url ?? null,
    orderToken: raw.order_token ?? null,
    trackingUrl: ld?.tracking_url ?? null,
    courierName: ld?.courier?.name ?? null,
    courierPhone: ld?.courier?.phone_number_for_customer ?? null,
    testMode: raw.test_mode ?? false,
    externalOrderRef: raw.external_order_ref ?? null,
    totalAmountDueCents: typeof ld?.total_amount_due === "number" ? ld.total_amount_due : null,
    feeCents: typeof ld?.fee === "number" ? ld.fee : null,
    currency: ld?.currency ?? null,
    // provider: строка ("Uber") или объект { id: "dsp_...", name }. Имя → provider, стабильный id → providerId.
    provider: typeof ld?.provider === "string" ? ld.provider : (ld?.provider?.name ?? null),
    providerId: ld?.provider && typeof ld.provider === "object" ? (ld.provider.id ?? null) : null,
    quoteId: ld?.quote_id ?? null,
    proofOfDeliveryUrls: normalizePodUrls(ld?.proof_of_delivery_image_urls),
    signatureImageUrl: normalizeSignatureUrl(ld?.signature_image_url),
  };
}

// ───────────────────────────  MOCK  ───────────────────────────

const mockStore = new Map<string, BurqOrder>();
const mockIdempotency = new Map<string, string>(); // idempotencyKey → order id

export function createMockBurqClient(): BurqClient {
  return {
    async createRoute() {
      return { id: `rt_mock_${randomUUID()}` };
    },
    async requestRouteQuotes() {
      /* mock считает мгновенно */
    },
    async listRouteQuotes() {
      return mockQuotes;
    },
    async deleteRoute() {
      /* нечего удалять */
    },
    mode: "mock",
    async createDraft(req, idempotencyKey) {
      const existingId = mockIdempotency.get(idempotencyKey);
      if (existingId) {
        const existing = mockStore.get(existingId);
        if (existing) return existing;
      }
      const id = `mock_${randomUUID()}`;
      const order: BurqOrder = {
        id,
        // ПРЕДПОЛАГАЕМЫЙ начальный статус, ПОДТВЕРЖДЁН доками как `request` (неинициированный).
        // Sandbox smoke-тест подтверждает фактически.
        status: "request",
        checkoutUrl: `https://dashboard.burqup.com/checkout/${id}`,
        orderToken: `mock_token_${id}`,
        trackingUrl: null,
        courierName: null,
        courierPhone: null,
        testMode: true,
        externalOrderRef: req.external_order_ref ?? null,
        totalAmountDueCents: null,
        feeCents: null,
        currency: null,
        provider: null,
        providerId: null,
        quoteId: null,
        proofOfDeliveryUrls: [],
        signatureImageUrl: null,
      };
      mockStore.set(id, order);
      mockIdempotency.set(idempotencyKey, id);
      return order;
    },
    async getOrder(id) {
      const found = mockStore.get(id);
      if (!found) throw new BurqApiError("mock order not found", 404);
      return found;
    },
    async deleteOrder(id) {
      const found = mockStore.get(id);
      if (!found) throw new BurqApiError("mock order not found", 404);
      if (found.status !== "request") {
        throw new BurqApiError("Order is already initiated and can no longer be deleted.", 400, "order_deletion_prohibited_in_current_state");
      }
      mockStore.delete(id);
    },
  };
}

/** Только для тестов: очистить mock-хранилище. */
export function __resetMockBurqStore(): void {
  mockStore.clear();
  mockIdempotency.clear();
}

/** Только для тестов: выставить сырой статус mock-заказа (эмуляция прогресса в Burq). */
export function __setMockBurqStatus(id: string, status: string): void {
  const found = mockStore.get(id);
  if (found) mockStore.set(id, { ...found, status });
}

/**
 * Только для тестов: чем ответит mock на запрос котировок. По умолчанию — Uber есть, чтобы
 * обычные прогоны не поднимали тревогу; сценарий «курьеров нет» задаётся явно пустым списком.
 */
let mockQuotes: RouteQuotesResponse = {
  status: "COMPLETE",
  data: [{ provider: "Uber", cost_of_delivery: 1849, burq_fee: 99 }],
};
export function __setMockRouteQuotes(next: RouteQuotesResponse): void {
  mockQuotes = next;
}

/** Только для тестов: выставить стоимость/провайдера mock-заказа (эмуляция dispatch). */
export function __setMockBurqCost(id: string, patch: Partial<BurqOrder>): void {
  const found = mockStore.get(id);
  if (found) mockStore.set(id, { ...found, ...patch });
}

// ───────────────────────────  REAL  ───────────────────────────

type RealConfig = { apiKey: string; baseUrl: string };

export function createRealBurqClient(cfg: RealConfig): BurqClient {
  async function call(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: { "x-api-key": cfg.apiKey, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }
  async function parseOrThrow(res: Response, ctx: string): Promise<BurqOrder> {
    const text = await res.text();
    if (!res.ok) {
      let code: string | null = null;
      try {
        code = (JSON.parse(text) as { code?: string }).code ?? null;
      } catch {
        /* тело не JSON — код неизвестен */
      }
      // Тело ответа — в сообщение, усечённо. Без него в dead-letter оставался голый «(400)», и
      // причину приходилось искать сравнением заказов между собой (так разбирали THEFLOW-20429).
      // Секретов в ответе Burq нет: это эхо нашего же запроса и текст валидации.
      const detail = text.trim().slice(0, 300);
      throw new BurqApiError(`Burq ${ctx} failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status, code);
    }
    return normalizeBurqOrder(JSON.parse(text) as BurqRawOrderResponse);
  }
  return {
    mode: "real",
    async createDraft(req, idempotencyKey) {
      // x-idempotency-key НЕ подтверждён доками — шлём как best-effort; app-level дедуп (hasCurrentDraft
      // + outbox) защищает независимо. Sandbox smoke-тест подтверждает фактическое поведение.
      const res = await call("/orders", { method: "POST", headers: { "x-idempotency-key": idempotencyKey }, body: JSON.stringify(req) });
      return parseOrThrow(res, "createDraft");
    },
    async getOrder(id) {
      const res = await call(`/orders/${encodeURIComponent(id)}?expand=latest_delivery`, { method: "GET" });
      return parseOrThrow(res, "getOrder");
    },
    async createRoute(orderIds) {
      const res = await call("/routes", { method: "POST", body: JSON.stringify({ order_ids: orderIds }) });
      const text = await res.text();
      if (!res.ok) throw new BurqApiError(`Burq createRoute failed (${res.status})`, res.status);
      return { id: (JSON.parse(text) as { id: string }).id };
    },
    async requestRouteQuotes(routeId) {
      // Тело не требуется: параметры (vehicle_type, quote_preference) нам не нужны — спрашиваем
      // ровно то, что увидит флорист в кабинете при «Any vehicle».
      const res = await call(`/routes/${encodeURIComponent(routeId)}/quotes`, { method: "POST", body: "{}" });
      if (!res.ok) throw new BurqApiError(`Burq requestRouteQuotes failed (${res.status})`, res.status);
    },
    async listRouteQuotes(routeId) {
      const res = await call(`/routes/${encodeURIComponent(routeId)}/quotes`, { method: "GET" });
      const text = await res.text();
      if (!res.ok) throw new BurqApiError(`Burq listRouteQuotes failed (${res.status})`, res.status);
      return JSON.parse(text) as RouteQuotesResponse;
    },
    async deleteRoute(routeId) {
      const res = await call(`/routes/${encodeURIComponent(routeId)}`, { method: "DELETE" });
      if (!res.ok) throw new BurqApiError(`Burq deleteRoute failed (${res.status})`, res.status);
    },
    async deleteOrder(id) {
      const res = await call(`/orders/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const text = await res.text();
        let code: string | null = null;
        try {
          code = (JSON.parse(text) as { code?: string }).code ?? null;
        } catch {
          /* не JSON */
        }
        throw new BurqApiError(`Burq deleteOrder failed (${res.status})`, res.status, code);
      }
    },
  };
}

/**
 * Безопасная проверка ключа: read-only `GET /orders?limit=1` (сущности НЕ создаются).
 * Возвращает только статус и БЕЗОПАСНОЕ сообщение (без секретов, без тела ответа/PII).
 * НЕ вызывает POST/DELETE и не создаёт заказов.
 */
export async function checkBurqAuth(cfg: { apiKey: string; baseUrl: string }): Promise<{ ok: boolean; status: number; safeMessage: string }> {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/orders?limit=1`, { method: "GET", headers: { "x-api-key": cfg.apiKey } });
    if (res.ok) return { ok: true, status: res.status, safeMessage: "ok" };
    return { ok: false, status: res.status, safeMessage: `HTTP ${res.status}` };
  } catch (err) {
    // Только тип ошибки сети — без URL/секретов.
    return { ok: false, status: 0, safeMessage: err instanceof Error ? err.name : "network_error" };
  }
}

// Реальный клиент для рантайма собирается из СОХРАНЁННЫХ в БД credentials (см. settings.ts
// getBurqRuntimeClient), а не из env. Здесь остаются только фабрики и безопасная проверка ключа.
