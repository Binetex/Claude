import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { TelegramSender } from "./sender";
import { resolveTelegramSettings, markVerified, markVerificationFailed } from "./settings";

/**
 * Последовательная проверка конфигурации: бот существует → умеет писать владельцу → умеет
 * писать флористам. Только после полного успеха выставляется verifiedAt, который и разрешает
 * включить уведомления.
 *
 * Наружу отдаются безопасные формулировки: описание ошибки от Telegram может содержать
 * лишнее, поэтому в UI и в lastErrorSafe идёт наш текст, а не сырой ответ провайдера.
 */
export type VerifyStep = { step: "getMe" | "owner" | "florists"; ok: boolean; detail: string };
export type VerifyResult = { ok: boolean; steps: VerifyStep[]; botUsername: string | null };

type GetMeResponse = { ok: boolean; result?: { username?: string; first_name?: string }; description?: string };

export async function verifyTelegram(prisma: PrismaClient): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];
  const s = await resolveTelegramSettings(prisma);

  if (!s.botToken) {
    await markVerificationFailed(prisma, "Токен бота не задан.");
    return { ok: false, steps: [{ step: "getMe", ok: false, detail: "Токен бота не задан." }], botUsername: null };
  }

  // 1) getMe — существует ли бот и валиден ли токен.
  let botUsername: string | null = null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${s.botToken}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const json = (await r.json().catch(() => null)) as GetMeResponse | null;
    if (!json?.ok) {
      const detail = r.status === 401 ? "Токен недействителен (401)." : `Telegram отклонил запрос (${r.status}).`;
      steps.push({ step: "getMe", ok: false, detail });
      await markVerificationFailed(prisma, detail);
      return { ok: false, steps, botUsername: null };
    }
    botUsername = json.result?.username ?? null;
    steps.push({ step: "getMe", ok: true, detail: botUsername ? `Бот @${botUsername}` : "Бот подтверждён" });
  } catch {
    const detail = "Не удалось связаться с Telegram (таймаут или сеть).";
    steps.push({ step: "getMe", ok: false, detail });
    await markVerificationFailed(prisma, detail);
    return { ok: false, steps, botUsername: null };
  }

  // 2–3) Тестовые сообщения в оба чата — проверяем именно право писать туда.
  const sender = new TelegramSender(s.botToken);
  const checks: { step: "owner" | "florists"; chatId: string | null; label: string }[] = [
    { step: "owner", chatId: s.ownerChatId, label: "владельца" },
    { step: "florists", chatId: s.floristsChatId, label: "флористов" },
  ];

  for (const c of checks) {
    if (!c.chatId) {
      steps.push({ step: c.step, ok: false, detail: `Chat ID ${c.label} не задан.` });
      continue;
    }
    const res = await sender.sendMessage(c.chatId, `✅ Floremart: проверка связи (чат ${c.label}).`);
    steps.push({
      step: c.step,
      ok: res.ok,
      detail: res.ok ? "Сообщение доставлено" : explain(res.code),
    });
  }

  const ok = steps.every((x) => x.ok);
  if (ok) await markVerified(prisma, botUsername);
  else await markVerificationFailed(prisma, steps.find((x) => !x.ok)?.detail ?? "Проверка не пройдена.");
  return { ok, steps, botUsername };
}

/** Человеческая формулировка вместо кода провайдера — без утечки описания от Telegram. */
function explain(code: string): string {
  if (code === "telegram_403") return "Бот не может писать в этот чат — добавьте его в чат и дайте право отправки.";
  if (code === "telegram_400") return "Неверный Chat ID (или чат недоступен боту).";
  if (code === "telegram_429") return "Telegram ограничил частоту запросов — повторите позже.";
  if (code.startsWith("network")) return "Нет связи с Telegram.";
  return "Не удалось отправить сообщение.";
}
