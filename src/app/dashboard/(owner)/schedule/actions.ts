"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { asClosureLevel } from "@/modules/timing/day";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Замок дня для всех флористов: утро, только вечер, весь день; null — открыть. Замок видят
 * ассистент и сайты с плагином доставки (`/api/public/morning-closures`).
 */
export async function setDayClosure(day: string, level: string | null): Promise<{ error?: string }> {
  const user = await requireRole("OWNER");
  if (!DAY_RE.test(day)) return { error: "Неверная дата." };
  if (level == null) {
    await prisma.morningClosure.deleteMany({ where: { day } });
  } else {
    const valid = asClosureLevel(level);
    if (!valid) return { error: "Неверный замок." };
    await prisma.morningClosure.upsert({
      where: { day },
      create: { day, level: valid, createdByUserId: user.id },
      update: { level: valid, createdByUserId: user.id },
    });
  }
  revalidatePath("/dashboard/schedule");
  return {};
}
