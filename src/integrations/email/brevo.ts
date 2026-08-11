import "server-only";
/**
 * Клиент Brevo для транзакционных писем по шаблонам.
 *
 * Аккаунт ОДИН на все магазины, поэтому ключ здесь общий и берётся ТОЛЬКО из переменной
 * окружения BREVO_API_KEY — в БД он не хранится и в ответах не появляется. Различия магазинов
 * (отправитель, reply-to, шаблон) приходят параметрами вызова.
 *
 * Отсутствие ключа — не исключение, а штатный статус `email_not_configured`: приложение должно
 * работать до того, как владелец настроит Brevo.
 *
 * API: POST https://api.brevo.com/v3/smtp/email, заголовок `api-key`.
 */
import type { EmailProvider, EmailSendParams, EmailSendResult } from "./types";

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const TIMEOUT_MS = 15_000;

/** Временные проблемы: имеет смысл повторить с backoff. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Базовая проверка адреса — до сети, чтобы не тратить запрос на явный мусор. */
export function isValidEmail(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  // Достаточно строго для отсечения мусора и достаточно свободно, чтобы не отвергать
  // валидные адреса с плюсами и поддоменами.
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v) && v.length <= 254;
}

/** Приведение адреса к каноничному виду: без пробелов, в нижнем регистре. */
export function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  return isValidEmail(v) ? v : null;
}

export function isBrevoConfigured(): boolean {
  return !!process.env.BREVO_API_KEY?.trim();
}

/**
 * `apiKeyOverride` — ключ, разрешённый вызывающим кодом (обычно из БД через accountKey.ts,
 * приоритетнее env). Не передан → берём env BREVO_API_KEY, как раньше (обратная совместимость).
 */
/**
 * Провайдер работает с ЯВНО переданным ключом. Ключ обязателен именно как аргумент: раньше при
 * его отсутствии подставлялся общий `BREVO_API_KEY` из env, а теперь ключи принадлежат магазинам,
 * и «ключ по умолчанию» означал бы письмо из чужого аккаунта Brevo. `null` — законное значение
 * «ключа нет», оно даёт понятный отказ, а не тихую подмену.
 */
export function createBrevoProvider(apiKey: string | null): EmailProvider {
  const key = apiKey?.trim() || null;
  return {
    name: "brevo",
    async sendTemplate(params: EmailSendParams): Promise<EmailSendResult> {
      const apiKey = key;
      if (!apiKey) {
        return {
          ok: false,
          code: "email_not_configured",
          safeError: "У магазина не задан Brevo API key — отправка недоступна.",
          retryable: false,
          configuration: true,
        };
      }

      const to = normalizeEmail(params.to);
      if (!to) {
        return { ok: false, code: "invalid_recipient_email", safeError: "Некорректный адрес получателя.", retryable: false };
      }
      if (!normalizeEmail(params.sender.email)) {
        return {
          ok: false,
          code: "invalid_sender_email",
          safeError: "У магазина некорректный адрес отправителя.",
          retryable: false,
          configuration: true,
        };
      }
      if (!Number.isInteger(params.brevoTemplateId) || params.brevoTemplateId <= 0) {
        return {
          ok: false,
          code: "invalid_template_id",
          safeError: "Не задан корректный Brevo Template ID.",
          retryable: false,
          configuration: true,
        };
      }

      // Brevo принимает либо числовой id отправителя, либо пару email+name. Числовой id
      // надёжнее (он привязан к подтверждённому домену), поэтому предпочитаем его.
      const senderIdNum = Number(params.sender.brevoSenderId);
      const sender =
        params.sender.brevoSenderId && Number.isInteger(senderIdNum) && senderIdNum > 0
          ? { id: senderIdNum }
          : { email: params.sender.email, ...(params.sender.name ? { name: params.sender.name } : {}) };

      const body = {
        sender,
        to: [{ email: to, ...(params.toName ? { name: params.toName } : {}) }],
        templateId: params.brevoTemplateId,
        params: params.params,
        ...(params.replyTo && normalizeEmail(params.replyTo) ? { replyTo: { email: normalizeEmail(params.replyTo)! } } : {}),
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(BREVO_URL, {
          method: "POST",
          headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await res.text();
        if (!res.ok) {
          // Текст провайдера в лог не тащим: он может содержать адрес получателя.
          const code = brevoErrorCode(res.status, text);
          return {
            ok: false,
            code,
            safeError: `Brevo ответил ${res.status} (${code}).`,
            retryable: RETRYABLE_STATUS.has(res.status),
            configuration: res.status === 401 || res.status === 403,
          };
        }

        let providerMessageId: string | null = null;
        try {
          const json = text ? (JSON.parse(text) as { messageId?: string }) : null;
          providerMessageId = json?.messageId ?? null;
        } catch {
          // Успешный ответ без разбираемого JSON — не повод считать отправку неудачной.
        }
        return { ok: true, providerMessageId };
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        return {
          ok: false,
          code: aborted ? "brevo_timeout" : "brevo_network",
          safeError: aborted ? "Brevo не ответил за 15 секунд." : "Сеть недоступна при обращении к Brevo.",
          retryable: true,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Код ошибки по статусу — чтобы история и тесты не зависели от текста Brevo. */
function brevoErrorCode(status: number, rawBody: string): string {
  if (status === 401 || status === 403) return "brevo_unauthorized";
  if (status === 429) return "brevo_rate_limit";
  if (status >= 500) return "brevo_server";
  // 400 у Brevo — это и «нет такого шаблона», и «незарегистрированный отправитель».
  if (status === 400) {
    if (/template/i.test(rawBody)) return "brevo_template_invalid";
    if (/sender/i.test(rawBody)) return "brevo_sender_invalid";
    return "brevo_bad_request";
  }
  return `brevo_http_${status}`;
}

export type VerifyAccountResult =
  | { ok: true; accountEmail: string | null }
  | { ok: false; code: string; safeError: string };

/**
 * Лёгкая проверка подключения (GET /v3/account) — ничего не отправляет, только подтверждает,
 * что ключ валиден. Используется кнопкой «Проверить подключение» в панели Brevo API key.
 */
export async function verifyBrevoApiKey(apiKey: string): Promise<VerifyAccountResult> {
  const key = apiKey.trim();
  if (!key) {
    return { ok: false, code: "email_not_configured", safeError: "API key пуст." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.brevo.com/v3/account", {
      method: "GET",
      headers: { "api-key": key, accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const code = brevoErrorCode(res.status, text);
      return { ok: false, code, safeError: `Brevo ответил ${res.status} (${code}).` };
    }
    try {
      const json = text ? (JSON.parse(text) as { email?: string }) : null;
      return { ok: true, accountEmail: json?.email ?? null };
    } catch {
      return { ok: true, accountEmail: null };
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      code: aborted ? "brevo_timeout" : "brevo_network",
      safeError: aborted ? "Brevo не ответил за 15 секунд." : "Сеть недоступна при обращении к Brevo.",
    };
  } finally {
    clearTimeout(timer);
  }
}
