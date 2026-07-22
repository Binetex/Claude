import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secretBox";

/**
 * Боты Telegram: один у владельца, по одному у каждого флориста.
 *
 * Почему у каждого флориста свой бот, а не общий: бот не может редактировать сообщение,
 * отправленное другим ботом. При передаче заказа прежний флорист должен увидеть, что заказ
 * ушёл — а это возможно только его же ботом. Chat ID живёт на боте, поэтому несколько ботов
 * спокойно пишут в один чат, если так настроить.
 */
export type BotPurpose = "OWNER" | "FLORIST" | "CUSTOMER_SERVICE";

export type ResolvedBot = { id: string; token: string; chatId: string; label: string };

/** Причина, по которой отправка невозможна. Различает «не настроено» и «выключено». */
export type BotSkip = "no_bot" | "bot_disabled" | "no_token" | "no_chat" | "bad_token_ciphertext";

export type BotLookup = { bot: ResolvedBot } | { skip: BotSkip };

function toResolved(b: {
  id: string; label: string; tokenEncrypted: string | null; chatId: string | null; enabled: boolean;
}): BotLookup {
  if (!b.enabled) return { skip: "bot_disabled" };
  if (!b.tokenEncrypted) return { skip: "no_token" };
  if (!b.chatId?.trim()) return { skip: "no_chat" };
  let token: string;
  try {
    token = decryptSecret(b.tokenEncrypted);
  } catch {
    // Сменился/пропал ключ шифрования — не падаем, сообщаем безопасную причину.
    return { skip: "bad_token_ciphertext" };
  }
  return { bot: { id: b.id, token, chatId: b.chatId.trim(), label: b.label } };
}

/** Бот владельца (singleton по смыслу: берём первый с purpose=OWNER). */
export async function resolveOwnerBot(prisma: PrismaClient): Promise<BotLookup> {
  const b = await prisma.telegramBot.findFirst({ where: { purpose: "OWNER" }, orderBy: { createdAt: "asc" } });
  if (!b) return { skip: "no_bot" };
  return toResolved(b);
}

/** Персональный бот флориста. Нет бота — уведомление тихо пропускается (решение владельца). */
export async function resolveFloristBot(prisma: PrismaClient, floristId: string): Promise<BotLookup> {
  const b = await prisma.telegramBot.findUnique({ where: { floristId } });
  if (!b) return { skip: "no_bot" };
  return toResolved(b);
}

/** Токен конкретного бота — нужен, чтобы редактировать ранее отправленное им сообщение. */
export async function resolveBotById(prisma: PrismaClient, botId: string): Promise<BotLookup> {
  const b = await prisma.telegramBot.findUnique({ where: { id: botId } });
  if (!b) return { skip: "no_bot" };
  return toResolved(b);
}

// ───────────────────────────  настройка из UI  ───────────────────────────

export type BotRow = {
  id: string;
  label: string;
  purpose: BotPurpose;
  floristId: string | null;
  floristName: string | null;
  tokenConfigured: boolean;
  chatId: string;
  enabled: boolean;
  verifiedAt: string | null;
  botUsername: string | null;
  lastErrorSafe: string | null;
};

/** Список для UI — без токенов. */
export async function listBots(prisma: PrismaClient): Promise<BotRow[]> {
  const bots = await prisma.telegramBot.findMany({
    include: { florist: { select: { user: { select: { name: true } } } } },
    orderBy: [{ purpose: "asc" }, { label: "asc" }],
  });
  return bots.map((b) => ({
    id: b.id,
    label: b.label,
    purpose: b.purpose as BotPurpose,
    floristId: b.floristId,
    floristName: b.florist?.user.name ?? null,
    tokenConfigured: !!b.tokenEncrypted,
    chatId: b.chatId ?? "",
    enabled: b.enabled,
    verifiedAt: b.verifiedAt ? b.verifiedAt.toISOString() : null,
    botUsername: b.botUsername,
    lastErrorSafe: b.lastErrorSafe,
  }));
}

export type UpsertBotInput = {
  purpose: BotPurpose;
  floristId?: string | null;
  label: string;
  /** Пустая строка = не менять существующий токен. */
  token?: string;
  chatId?: string;
};

/**
 * Создание/обновление бота. Пустой токен не стирает существующий. Изменение токена или чата
 * сбрасывает проверку и выключает бота — включённая, но непроверенная конфигурация недопустима.
 */
export async function upsertBot(prisma: PrismaClient, input: UpsertBotInput): Promise<{ id: string }> {
  const token = input.token?.trim();
  const chatId = input.chatId?.trim() || null;
  const existing = input.floristId
    ? await prisma.telegramBot.findUnique({ where: { floristId: input.floristId } })
    : await prisma.telegramBot.findFirst({ where: { purpose: input.purpose } });

  const changed = !!token || chatId !== (existing?.chatId ?? null);
  const data = {
    label: input.label,
    purpose: input.purpose,
    chatId,
    ...(token ? { tokenEncrypted: encryptSecret(token) } : {}),
    ...(changed ? { verifiedAt: null, enabled: false, botUsername: null, lastErrorSafe: null } : {}),
  };

  if (existing) {
    await prisma.telegramBot.update({ where: { id: existing.id }, data });
    return { id: existing.id };
  }
  const created = await prisma.telegramBot.create({
    data: { ...data, floristId: input.floristId ?? null },
    select: { id: true },
  });
  return created;
}

export async function deleteBotToken(prisma: PrismaClient, botId: string): Promise<void> {
  await prisma.telegramBot.update({
    where: { id: botId },
    data: { tokenEncrypted: null, verifiedAt: null, enabled: false, botUsername: null },
  });
}

export async function setBotEnabled(prisma: PrismaClient, botId: string, enabled: boolean): Promise<{ ok: true } | { error: string }> {
  const b = await prisma.telegramBot.findUnique({ where: { id: botId }, select: { verifiedAt: true } });
  if (!b) return { error: "Бот не найден." };
  if (enabled && !b.verifiedAt) return { error: "Сначала выполните проверку — включать непроверенного бота нельзя." };
  await prisma.telegramBot.update({ where: { id: botId }, data: { enabled } });
  return { ok: true };
}
