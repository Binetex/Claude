import "server-only";
/**
 * Приём ответов от бота — регистрация вебхука у Telegram и его состояние.
 *
 * Своего флага «приём включён» в БД нет и заводить его не надо: правда живёт у Telegram, и
 * состояние спрашивается у него же (`getWebhookInfo`). Флаг в БД разошёлся бы с ней при первом
 * же сбросе вебхука руками или из другого приложения — и владелец жал бы кнопку, которая
 * «включена», а ответы не приходят.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveBotById } from "./bots";
import { getAppUrl } from "@/lib/appUrl";

export type RepliesStatus = {
  /** Вебхук стоит и указывает на нас. */
  enabled: boolean;
  /** Почему выключен или что не так: человеку, без токенов. */
  detail: string | null;
  /** Последняя ошибка доставки, которую помнит Telegram. */
  lastError: string | null;
};

const TELEGRAM_TIMEOUT_MS = 4_000;

export function webhookUrlFor(botId: string): string {
  return `${getAppUrl()}/api/webhooks/telegram/${botId}`;
}

async function call(token: string, method: string, body?: Record<string, unknown>): Promise<{ ok?: boolean; description?: string; result?: unknown } | null> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  }).catch(() => null);
  return (await res?.json().catch(() => null)) as { ok?: boolean; description?: string; result?: unknown } | null;
}

/** Состояние приёма у одного бота. Бот выключен или без токена — приёма нет по определению. */
export async function getRepliesStatus(prisma: PrismaClient, botId: string): Promise<RepliesStatus> {
  const lookup = await resolveBotById(prisma, botId);
  if (!("bot" in lookup)) {
    const detail =
      lookup.skip === "bot_disabled" ? "бот выключен" : lookup.skip === "no_token" ? "нет токена" : lookup.skip === "no_chat" ? "нет Chat ID" : lookup.skip;
    return { enabled: false, detail, lastError: null };
  }
  const json = await call(lookup.bot.token, "getWebhookInfo");
  if (!json?.ok) return { enabled: false, detail: "Telegram не ответил — состояние неизвестно", lastError: null };
  const info = (json.result ?? {}) as { url?: string; last_error_message?: string; pending_update_count?: number };
  const ours = webhookUrlFor(botId);
  if (!info.url) return { enabled: false, detail: null, lastError: null };
  if (info.url !== ours) return { enabled: false, detail: "вебхук указывает на другой адрес", lastError: null };
  return { enabled: true, detail: null, lastError: info.last_error_message ?? null };
}

/** Состояние приёма у всех ботов разом — для страницы настроек. */
export async function getRepliesStatusMap(prisma: PrismaClient, botIds: string[]): Promise<Record<string, RepliesStatus>> {
  const entries = await Promise.all(botIds.map(async (id) => [id, await getRepliesStatus(prisma, id)] as const));
  return Object.fromEntries(entries);
}

export async function enableReplies(prisma: PrismaClient, botId: string, secret: string): Promise<{ ok: true } | { error: string }> {
  const lookup = await resolveBotById(prisma, botId);
  if (!("bot" in lookup)) return { error: `Бот недоступен: ${lookup.skip === "bot_disabled" ? "сначала включите бота" : lookup.skip}` };
  const json = await call(lookup.bot.token, "setWebhook", {
    url: webhookUrlFor(botId),
    secret_token: secret,
    // Нам нужны только ответы владельца и нажатия кнопок — остальное Telegram может не слать.
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  if (!json?.ok) return { error: `Telegram отказал: ${json?.description ?? "нет ответа"}` };
  return { ok: true };
}

export async function disableReplies(prisma: PrismaClient, botId: string): Promise<{ ok: true } | { error: string }> {
  const lookup = await resolveBotById(prisma, botId);
  if (!("bot" in lookup)) return { ok: true }; // выключенному боту снимать нечего
  const json = await call(lookup.bot.token, "deleteWebhook");
  if (!json?.ok) return { error: `Telegram отказал: ${json?.description ?? "нет ответа"}` };
  return { ok: true };
}
