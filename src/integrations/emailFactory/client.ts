import "server-only";
/**
 * Клиент Email Factory (`mail.binetex.com`) — ТОЛЬКО ручная переписка с клиентом из карточки
 * заказа. В каналах автоматизаций его быть не должно: транзакционные письма живут в Brevo, и
 * второй отправитель означал бы одно письмо, ушедшее дважды с двух разных адресов.
 *
 * Контракт снят с живого API 2026-08-12, а не из документации (её нет). Что проверено:
 *  - `GET /api/v1/messages` отдаёт `{data:[…]}`; `since` (ISO) и `direction` РЕАЛЬНО фильтруют,
 *    значения направления — заглавные (`INBOUND`/`OUTBOUND`), строчные дают 400;
 *  - параметр `to` МОЛЧА ИГНОРИРУЕТСЯ — фильтровать по своему адресу на стороне API нельзя,
 *    только у себя после получения. Это проверено разводящим запросом: несуществующий адрес
 *    вернул то же письмо, что и реальный;
 *  - `POST /api/v1/threads/{id}/reply` принимает `{text}` и отвечает 404 THREAD_NOT_FOUND на
 *    неизвестный тред;
 *  - `POST /api/v1/messages` требует `to`, `subject`, `text` (никакого `domain`);
 *  - ошибки приходят как `{error:{code,message}}`.
 */
import { EMAIL_FACTORY_BASE_URL } from "./token";

const TIMEOUT_MS = 15_000;

export type EmailFactoryMessage = {
  id: string;
  threadId: string | null;
  direction: "INBOUND" | "OUTBOUND";
  fromEmail: string;
  toEmail: string;
  subject: string | null;
  /** Только plain text. `html` намеренно не берём: в карточке нужен смысл, а не вёрстка. */
  text: string;
  occurredAt: Date;
};

export type ClientResult<T> = { ok: true; data: T } | { ok: false; code: string; retryable: boolean };

/** Временные беды: повторить позже. Всё остальное повторять бессмысленно. */
const RETRYABLE = new Set(["ef_network", "ef_timeout", "ef_server", "ef_rate_limit"]);

function codeFromStatus(status: number): string {
  if (status === 401 || status === 403) return "ef_unauthorized";
  if (status === 404) return "ef_not_found";
  if (status === 429) return "ef_rate_limit";
  if (status >= 500) return "ef_server";
  return "ef_client";
}

async function call(token: string, method: string, path: string, body?: unknown): Promise<ClientResult<unknown>> {
  let res: Response;
  try {
    res = await fetch(`${EMAIL_FACTORY_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const code = err instanceof Error && err.name === "TimeoutError" ? "ef_timeout" : "ef_network";
    return { ok: false, code, retryable: true };
  }

  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // Не JSON — почти наверняка HTML страницы входа, то есть проблема доступа, а не данных.
    return { ok: false, code: "ef_bad_response", retryable: false };
  }

  if (!res.ok) {
    // Код провайдера информативнее HTTP-статуса (THREAD_NOT_FOUND, VALIDATION_ERROR), берём его.
    const providerCode = (parsed as { error?: { code?: string } } | null)?.error?.code;
    const code = providerCode ? `ef_${providerCode.toLowerCase()}` : codeFromStatus(res.status);
    return { ok: false, code, retryable: RETRYABLE.has(code) || res.status >= 500 || res.status === 429 };
  }
  return { ok: true, data: parsed };
}

/** У провайдера адрес приходит то строкой, то списком — приводим к одному виду. */
function oneAddress(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v) && v.length && typeof v[0] === "string") return String(v[0]).trim();
  return "";
}

function toMessage(raw: unknown): EmailFactoryMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id : null;
  const fromEmail = oneAddress(m.from);
  const toEmail = oneAddress(m.to);
  // Письмо без id нечем дедуплицировать, без адресов — не с кем связать. Такое пропускаем целиком:
  // строка-полуфабрикат в истории переписки хуже отсутствующей.
  if (!id || !fromEmail || !toEmail) return null;

  const when = m.receivedAt ?? m.sentAt ?? m.createdAt;
  const occurredAt = typeof when === "string" || when instanceof Date ? new Date(when) : new Date();
  if (Number.isNaN(occurredAt.getTime())) return null;

  return {
    id,
    threadId: typeof m.threadId === "string" ? m.threadId : null,
    direction: m.direction === "OUTBOUND" ? "OUTBOUND" : "INBOUND",
    fromEmail,
    toEmail,
    subject: typeof m.subject === "string" ? m.subject : null,
    text: typeof m.text === "string" ? m.text : "",
    occurredAt,
  };
}

/**
 * Входящие письма, начиная с `since`. Фильтра по нашему адресу у провайдера нет, поэтому вернётся
 * входящая почта ВСЕХ доменов аккаунта — разбор «чьё это письмо» делается у нас.
 */
export async function listInbound(token: string, since: Date, limit = 100): Promise<ClientResult<EmailFactoryMessage[]>> {
  const q = new URLSearchParams({ direction: "INBOUND", since: since.toISOString(), limit: String(limit) });
  const res = await call(token, "GET", `/api/v1/messages?${q.toString()}`);
  if (!res.ok) return res;

  const list = (res.data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return { ok: false, code: "ef_bad_response", retryable: false };
  return { ok: true, data: list.map(toMessage).filter((m): m is EmailFactoryMessage => m !== null) };
}

/** Ответ в существующий тред. Провайдер сам проставляет In-Reply-To/References. */
export async function replyToThread(token: string, threadId: string, text: string): Promise<ClientResult<{ id: string | null }>> {
  const res = await call(token, "POST", `/api/v1/threads/${encodeURIComponent(threadId)}/reply`, { text });
  if (!res.ok) return res;
  const d = (res.data as { data?: { id?: unknown } } | null)?.data;
  return { ok: true, data: { id: typeof d?.id === "string" ? d.id : null } };
}
