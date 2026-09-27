"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Закрыть или открыть утро на дату для всех флористов. Закрытие видит ассистент. */
export async function setMorningClosure(day: string, closed: boolean): Promise<{ error?: string }> {
  const user = await requireRole("OWNER");
  if (!DAY_RE.test(day)) return { error: "Неверная дата." };
  if (closed) {
    await prisma.morningClosure.upsert({ where: { day }, create: { day, createdByUserId: user.id }, update: {} });
  } else {
    await prisma.morningClosure.deleteMany({ where: { day } });
  }
  revalidatePath("/dashboard/schedule");
  return {};
}
