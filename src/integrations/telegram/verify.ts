import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { TelegramSender } from "./sender";
import { resolveBotById } from "./bots";

/**
 * Проверка КОНКРЕТНОГО бота: существует ли он (getMe) и может ли писать в назначенный чат.
 * Только после полного успеха выставляется verifiedAt, который и разрешает включить бота.
 *
 * Наружу отдаются человеческие формулировки: сырое описание ошибки Telegram может содержать
 * лишнее, поэтому в UI идёт наш текст.
 */
export type VerifyStep = { step: "getMe" | "chat"; ok: boolean; detail: string };
export type VerifyResult = { ok: boolean; steps: VerifyStep[]; botUsername: string | null };

type GetMeResponse = { ok: boolean; result?: { username?: string }; description?: string };

export async function verifyBot(prisma: PrismaClient, botId: string): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];
  const lookup = await resolveBotById(prisma, botId);

  if ("skip" in lookup) {
    const detail =
      lookup.skip === "no_token" ? "Токен не задан."
      : lookup.skip === "no_chat" ? "Chat ID не задан."
      : lookup.skip === "bad_token_ciphertext" ? "Токен не расшифровывается — сохраните его заново."
      : lookup.skip === "no_bot" ? "Бот не найден."
      : "Бот выключен."; // bot_disabled: проверять можно и выключенного — резолвер строг, разрешаем ниже
    if (lookup.skip !== "bot_disabled") {
      await fail(prisma, botId, detail);
      return { ok: false, steps: [{ step: "getMe", ok: false, detail }], botUsername: null };
    }
  }

  // Выключенного бота проверять МОЖНО и нужно — иначе его нельзя было бы включить.
  const raw = await prisma.telegramBot.findUnique({ where: { id: botId } });
  if (!raw?.tokenEncrypted || !raw.chatId?.trim()) {
    const detail = !raw?.tokenEncrypted ? "Токен не задан." : "Chat ID не задан.";
    await fail(prisma, botId, detail);
    return { ok: false, steps: [{ step: "getMe", ok: false, detail }], botUsername: null };
  }
  const { decryptSecret } = await import("@/lib/crypto/secretBox");
  let token: string;
  try {
    token = decryptSecret(raw.tokenEncrypted);
  } catch {
    const detail = "Токен не расшифровывается — сохраните его заново.";
    await fail(prisma, botId, detail);
    return { ok: false, steps: [{ step: "getMe", ok: false, detail }], botUsername: null };
  }

  // 1) getMe — валиден ли токен.
  let botUsername: string | null = null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const json = (await r.json().catch(() => null)) as GetMeResponse | null;
    if (!json?.ok) {
      const detail = r.status === 401 ? "Токен недействителен (401)." : `Telegram отклонил запрос (${r.status}).`;
      steps.push({ step: "getMe", ok: false, detail });
      await fail(prisma, botId, detail);
      return { ok: false, steps, botUsername: null };
    }
    botUsername = json.result?.username ?? null;
    steps.push({ step: "getMe", ok: true, detail: botUsername ? `Бот @${botUsername}` : "Бот подтверждён" });
  } catch {
    const detail = "Не удалось связаться с Telegram (таймаут или сеть).";
    steps.push({ step: "getMe", ok: false, detail });
    await fail(prisma, botId, detail);
    return { ok: false, steps, botUsername: null };
  }

  // 2) Тестовое сообщение — проверяем именно право писать в этот чат.
  const res = await new TelegramSender(token).sendMessage(raw.chatId.trim(), `✅ Floremart: проверка связи (${raw.label}).`);
  steps.push({ step: "chat", ok: res.ok, detail: res.ok ? "Сообщение доставлено" : explain(res.code) });

  const ok = steps.every((s) => s.ok);
  if (ok) {
    await prisma.telegramBot.update({ where: { id: botId }, data: { verifiedAt: new Date(), botUsername, lastErrorSafe: null } });
  } else {
    await fail(prisma, botId, steps.find((s) => !s.ok)?.detail ?? "Проверка не пройдена.");
  }
  return { ok, steps, botUsername };
}

async function fail(prisma: PrismaClient, botId: string, safeError: string) {
  await prisma.telegramBot
    .update({ where: { id: botId }, data: { verifiedAt: null, enabled: false, lastErrorSafe: safeError } })
    .catch(() => undefined);
}

function explain(code: string): string {
  if (code === "telegram_403") return "Бот не может писать в этот чат — напишите боту /start или добавьте его в чат.";
  if (code === "telegram_400") return "Неверный Chat ID (или чат недоступен боту).";
  if (code === "telegram_429") return "Telegram ограничил частоту — повторите позже.";
  if (code.startsWith("network")) return "Нет связи с Telegram.";
  return "Не удалось отправить сообщение.";
}
