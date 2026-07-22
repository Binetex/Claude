import "server-only";
/**
 * Глобальный «рубильник» автоматизаций (singleton). При disableAll=true движок не создаёт новые
 * job'ы (trigger) и не отправляет due job'ы (send). Строка создаётся лениво при первом переключении
 * — без seed. Отсутствие строки трактуется как disableAll=false.
 */
import type { PrismaClient } from "@/generated/prisma/client";

const SINGLETON = "singleton";

export async function isAutomationsGloballyDisabled(prisma: PrismaClient): Promise<boolean> {
  const s = await prisma.automationSettings.findUnique({ where: { id: SINGLETON }, select: { disableAll: true } });
  return s?.disableAll ?? false;
}

export async function getAutomationSettings(prisma: PrismaClient): Promise<{ disableAll: boolean; updatedAt: Date | null }> {
  const s = await prisma.automationSettings.findUnique({ where: { id: SINGLETON }, select: { disableAll: true, updatedAt: true } });
  return { disableAll: s?.disableAll ?? false, updatedAt: s?.updatedAt ?? null };
}

export async function setAutomationsGloballyDisabled(prisma: PrismaClient, disableAll: boolean, userId: string | null): Promise<void> {
  await prisma.automationSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, disableAll, updatedByUserId: userId },
    update: { disableAll, updatedByUserId: userId },
  });
}
