import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";

/** Какие магазины на ком: ИИ новому клиенту магазина отвечает по его первому флористу. */
export async function loadShopsOf(prisma: PrismaClient): Promise<(floristId: string) => string> {
  const firsts = await prisma.siteFloristPriority.findMany({ where: { position: 0 }, select: { floristId: true, site: { select: { shortName: true } } } });
  return (id) => firsts.filter((p) => p.floristId === id).map((p) => p.site.shortName).join(", ");
}
