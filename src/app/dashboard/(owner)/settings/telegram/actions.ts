"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { enableReplies, disableReplies } from "@/integrations/telegram/replies";
import { upsertBot, deleteBotToken, setBotEnabled, type BotPurpose } from "@/integrations/telegram/bots";
import { setTelegramGlobalEnabled } from "@/integrations/telegram/settings";
import { verifyBot, type VerifyResult } from "@/integrations/telegram/verify";

export type ActionResult = { ok?: true; message?: string; error?: string };

const PATH = "/dashboard/settings/telegram";

/** Chat ID — целое число (у групп отрицательное). Проверяем, чтобы не ловить 400 от Telegram. */
function badChatId(v: string): boolean {
  return !!v && !/^-?\d+$/.test(v);
}

export async function saveBot(input: {
  purpose: BotPurpose;
  floristId?: string | null;
  label: string;
  token: string;
  chatId: string;
}): Promise<ActionResult> {
  await requireRole("OWNER");
  const chatId = input.chatId.trim();
  if (badChatId(chatId)) return { error: "Chat ID должен быть числом (у групп — отрицательным)." };
  await upsertBot(prisma, {
    purpose: input.purpose,
    floristId: input.floristId ?? null,
    label: input.label,
    token: input.token,
    chatId,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Сохранено. Выполните проверку." };
}

export async function removeBotToken(botId: string): Promise<ActionResult> {
  await requireRole("OWNER");
  await deleteBotToken(prisma, botId);
  revalidatePath(PATH);
  return { ok: true, message: "Токен удалён, бот выключен." };
}

/** getMe → тестовое сообщение в назначенный чат. */
export async function verifyBotAction(botId: string): Promise<{ result: VerifyResult } | { error: string }> {
  await requireRole("OWNER");
  try {
    return { result: await verifyBot(prisma, botId) };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : "Проверка не выполнена." };
  } finally {
    revalidatePath(PATH);
  }
}

export async function toggleBot(botId: string, enabled: boolean): Promise<ActionResult> {
  await requireRole("OWNER");
  // Выключенный бот не должен и принимать: иначе Telegram продолжит слать обновления на адрес,
  // где их некому разбирать, и через сутки бросит вебхук с ошибкой. Сбой снятия не блокирует
  // выключение — приём и так проверяет, включён ли бот.
  if (!enabled) await disableReplies(prisma, botId).catch(() => null);
  const r = await setBotEnabled(prisma, botId, enabled);
  revalidatePath(PATH);
  if ("error" in r) return { error: r.error };
  return { ok: true, message: enabled ? "Бот включён." : "Бот выключен." };
}

/** Общий рубильник всей рассылки. Проверка не требуется — гасить нужно уметь всегда. */
export async function toggleGlobal(enabled: boolean): Promise<ActionResult> {
  await requireRole("OWNER");
  await setTelegramGlobalEnabled(prisma, enabled);
  revalidatePath(PATH);
  return { ok: true, message: enabled ? "Уведомления включены." : "Уведомления выключены." };
}

/**
 * Включает приём ответов от этого бота: регистрирует у Telegram адрес вебхука и секрет.
 *
 * Без этого шага бот умеет только писать: кнопка «Отправить» и ответ реплаем ничего не сделают,
 * потому что Telegram просто некуда доставлять обновления. Секрет проверяется на приёме — адрес
 * попадает в логи и историю, одного его мало.
 */
export async function enableBotRepliesAction(botId: string): Promise<ActionResult> {
  await requireRole("OWNER");
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret) return { error: "Не задан TELEGRAM_WEBHOOK_SECRET — приём ответов включить нельзя." };
  const r = await enableReplies(prisma, botId, secret);
  revalidatePath(PATH);
  if ("error" in r) return { error: r.error };
  return { ok: true, message: "Приём ответов включён" };
}

export async function disableBotRepliesAction(botId: string): Promise<ActionResult> {
  await requireRole("OWNER");
  const r = await disableReplies(prisma, botId);
  revalidatePath(PATH);
  if ("error" in r) return { error: r.error };
  return { ok: true, message: "Приём ответов выключен" };
}
