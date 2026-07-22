import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret, decryptSecret, isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";

/**
 * Настройки Telegram-уведомлений: singleton-строка + шифрование токена.
 *
 * Правило безопасности: расшифрованный токен НИКОГДА не покидает сервер — наружу отдаётся
 * только признак «настроен». Любое изменение токена или чата сбрасывает verifiedAt и enabled,
 * чтобы нельзя было оставить включённым конфиг, который уже никто не проверял.
 */
const SINGLETON = "singleton";

export type TelegramSettingsView = {
  botTokenConfigured: boolean;
  ownerChatId: string;
  floristsChatId: string;
  enabled: boolean;
  verifiedAt: string | null;
  botUsername: string | null;
  lastErrorSafe: string | null;
  cryptoConfigured: boolean;
};

export type TelegramResolved = {
  botToken: string | null;
  ownerChatId: string | null;
  floristsChatId: string | null;
  enabled: boolean;
};

async function row(prisma: PrismaClient) {
  return prisma.telegramSettings.findUnique({ where: { id: SINGLETON } });
}

/** Представление для UI — без секрета и без расшифровки. */
export async function loadTelegramSettingsView(prisma: PrismaClient): Promise<TelegramSettingsView> {
  const s = await row(prisma);
  return {
    botTokenConfigured: !!s?.botTokenEncrypted,
    ownerChatId: s?.ownerChatId ?? "",
    floristsChatId: s?.floristsChatId ?? "",
    enabled: !!s?.enabled,
    verifiedAt: s?.verifiedAt ? s.verifiedAt.toISOString() : null,
    botUsername: s?.botUsername ?? null,
    lastErrorSafe: s?.lastErrorSafe ?? null,
    cryptoConfigured: isCredentialCryptoConfigured(),
  };
}

/** Рабочая конфигурация для отправки. Токен расшифровывается только здесь, на сервере. */
export async function resolveTelegramSettings(prisma: PrismaClient): Promise<TelegramResolved> {
  const s = await row(prisma);
  if (!s) return { botToken: null, ownerChatId: null, floristsChatId: null, enabled: false };
  let botToken: string | null = null;
  if (s.botTokenEncrypted) {
    try {
      botToken = decryptSecret(s.botTokenEncrypted);
    } catch {
      // Ключ шифрования сменился/отсутствует — считаем токен ненастроенным, а не падаем.
      botToken = null;
    }
  }
  return {
    botToken,
    ownerChatId: s.ownerChatId?.trim() || null,
    floristsChatId: s.floristsChatId?.trim() || null,
    enabled: s.enabled,
  };
}

export type SaveInput = {
  /** Пустая строка = НЕ менять существующий токен (поле в UI всегда пустое). */
  botToken?: string;
  ownerChatId?: string;
  floristsChatId?: string;
};

/**
 * Сохранение. Пустой токен не стирает существующий — для удаления есть отдельное действие.
 * Изменение любого значения сбрасывает подтверждение: включать непроверенный конфиг нельзя.
 */
export async function saveTelegramSettings(prisma: PrismaClient, input: SaveInput): Promise<void> {
  const current = await row(prisma);
  const token = input.botToken?.trim();
  const owner = input.ownerChatId?.trim() ?? "";
  const florists = input.floristsChatId?.trim() ?? "";

  const changed =
    (!!token && token.length > 0) ||
    owner !== (current?.ownerChatId ?? "") ||
    florists !== (current?.floristsChatId ?? "");

  const data = {
    ...(token ? { botTokenEncrypted: encryptSecret(token) } : {}),
    ownerChatId: owner || null,
    floristsChatId: florists || null,
    ...(changed ? { verifiedAt: null, enabled: false, botUsername: null, lastErrorSafe: null } : {}),
  };
  await prisma.telegramSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...data },
    update: data,
  });
}

/** Явное удаление токена — отдельным действием, чтобы это нельзя было сделать случайно. */
export async function deleteTelegramToken(prisma: PrismaClient): Promise<void> {
  await prisma.telegramSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, enabled: false },
    update: { botTokenEncrypted: null, verifiedAt: null, enabled: false, botUsername: null },
  });
}

export async function markVerified(prisma: PrismaClient, botUsername: string | null): Promise<void> {
  await prisma.telegramSettings.update({
    where: { id: SINGLETON },
    data: { verifiedAt: new Date(), botUsername, lastErrorSafe: null },
  });
}

export async function markVerificationFailed(prisma: PrismaClient, safeError: string): Promise<void> {
  await prisma.telegramSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, lastErrorSafe: safeError },
    update: { verifiedAt: null, enabled: false, lastErrorSafe: safeError },
  });
}

/** Включение возможно ТОЛЬКО после успешной проверки текущей конфигурации. */
export async function setTelegramEnabled(prisma: PrismaClient, enabled: boolean): Promise<{ ok: true } | { error: string }> {
  const s = await row(prisma);
  if (enabled && !s?.verifiedAt) return { error: "Сначала выполните проверку подключения — включать непроверенную конфигурацию нельзя." };
  await prisma.telegramSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, enabled },
    update: { enabled },
  });
  return { ok: true };
}
