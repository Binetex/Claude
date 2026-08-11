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

export type SenderCheckResult =
  | { ok: true; verified: boolean; knownSenders: string[] }
  | { ok: false; code: string; safeError: string };

/**
 * Подтверждён ли адрес отправителя В ЭТОМ аккаунте Brevo (GET /v3/senders).
 *
 * Зачем отдельно от проверки ключа: `GET /v3/account` отвечает только «ключ живой». Аккаунт при
 * этом может ничего не знать про наш домен — и тогда Brevo ПРИНИМАЕТ письмо по API, отдаёт
 * messageId, а на доставке блокирует. Снаружи это выглядит как «отправили, но не пришло»
 * (ровно так потерялось первое письмо TheFlow из нового аккаунта).
 *
 * Сравнение по адресу без учёта регистра. Неактивный отправитель считается неподтверждённым:
 * Brevo с него не отправит.
 */
export async function verifyBrevoSender(apiKey: string, senderEmail: string): Promise<SenderCheckResult> {
  const key = apiKey.trim();
  const wanted = normalizeEmail(senderEmail);
  if (!key) return { ok: false, code: "email_not_configured", safeError: "API key пуст." };
  if (!wanted) return { ok: false, code: "invalid_sender_email", safeError: "Адрес отправителя некорректен." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.brevo.com/v3/senders", {
      method: "GET",
      headers: { "api-key": key, accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const code = brevoErrorCode(res.status, text);
      return { ok: false, code, safeError: `Brevo ответил ${res.status} (${code}).` };
    }
    const json = text ? (JSON.parse(text) as { senders?: { email?: string; active?: boolean }[] }) : null;
    const senders = json?.senders ?? [];
    const known = senders.map((x) => normalizeEmail(x.email ?? "")).filter((x): x is string => !!x);
    const verified = senders.some((x) => normalizeEmail(x.email ?? "") === wanted && x.active !== false);
    return { ok: true, verified, knownSenders: known };
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

export type TemplateCheckResult =
  | { ok: true; exists: boolean; active: boolean; name: string | null }
  | { ok: false; code: string; safeError: string };

/**
 * Существует ли шаблон в ЭТОМ аккаунте Brevo и включён ли он (GET /v3/smtp/templates/{id}).
 *
 * Зачем: Brevo принимает отправку по выключенному шаблону, отдаёт messageId — и отказывает уже
 * на самой отправке, с событием `error: template is disabled` в журнале аккаунта. Наружу это
 * выглядит как «тест прошёл, письмо не пришло». Ровно так потерялось первое письмо TheFlow:
 * шаблон №1 в новом аккаунте оказался выключённым черновиком «New template».
 */
export async function verifyBrevoTemplate(apiKey: string, templateId: number): Promise<TemplateCheckResult> {
  const key = apiKey.trim();
  if (!key) return { ok: false, code: "email_not_configured", safeError: "API key пуст." };
  if (!Number.isInteger(templateId) || templateId <= 0) {
    return { ok: false, code: "invalid_template_id", safeError: "Некорректный Template ID." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.brevo.com/v3/smtp/templates/${templateId}`, {
      method: "GET",
      headers: { "api-key": key, accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (res.status === 404) return { ok: true, exists: false, active: false, name: null };
    if (!res.ok) {
      const code = brevoErrorCode(res.status, text);
      return { ok: false, code, safeError: `Brevo ответил ${res.status} (${code}).` };
    }
    const json = text ? (JSON.parse(text) as { name?: string; isActive?: boolean }) : null;
    return { ok: true, exists: true, active: json?.isActive === true, name: json?.name ?? null };
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
