"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { saveTelegramSettings, deleteTelegramToken, setTelegramEnabled } from "@/integrations/telegram/settings";
import { verifyTelegram, type VerifyResult } from "@/integrations/telegram/verify";

export type ActionResult = { ok?: true; message?: string; error?: string };

const PATH = "/dashboard/settings/telegram";

/** Пустой токен НЕ стирает существующий — для удаления есть отдельное действие. */
export async function saveSettings(input: { botToken: string; ownerChatId: string; floristsChatId: string }): Promise<ActionResult> {
  await requireRole("OWNER");
  const owner = input.ownerChatId.trim();
  const florists = input.floristsChatId.trim();
  for (const [label, v] of [["владельца", owner], ["флористов", florists]] as const) {
    // Chat ID — целое число, у групп отрицательное. Проверяем формат, чтобы не ловить 400 от Telegram.
    if (v && !/^-?\d+$/.test(v)) return { error: `Chat ID ${label} должен быть числом (у групп — отрицательным).` };
  }
  await saveTelegramSettings(prisma, { botToken: input.botToken, ownerChatId: owner, floristsChatId: florists });
  revalidatePath(PATH);
  return { ok: true, message: "Сохранено. Выполните проверку подключения." };
}

export async function removeToken(): Promise<ActionResult> {
  await requireRole("OWNER");
  await deleteTelegramToken(prisma);
  revalidatePath(PATH);
  return { ok: true, message: "Токен удалён, уведомления выключены." };
}

/** getMe → тестовое сообщение владельцу → тестовое сообщение флористам. */
export async function verifyConnection(): Promise<{ result: VerifyResult } | { error: string }> {
  await requireRole("OWNER");
  try {
    return { result: await verifyTelegram(prisma) };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : "Проверка не выполнена." };
  } finally {
    revalidatePath(PATH);
  }
}

export async function toggleEnabled(enabled: boolean): Promise<ActionResult> {
  await requireRole("OWNER");
  const r = await setTelegramEnabled(prisma, enabled);
  revalidatePath(PATH);
  if ("error" in r) return { error: r.error };
  return { ok: true, message: enabled ? "Уведомления включены." : "Уведомления выключены." };
}
