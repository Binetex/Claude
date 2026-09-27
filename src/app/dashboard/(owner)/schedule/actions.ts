"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Больше двадцати баллов к трём часам не бывает: это опечатка, а не флорист. */
const MAX_CAPACITY = 20;

/** Закрыть или открыть утро на дату для всех флористов. Закрытие видит ассистент. */
export async function setMorningClosure(day: string, closed: boolean, note: string): Promise<{ error?: string }> {
  const user = await requireRole("OWNER");
  if (!DAY_RE.test(day)) return { error: "Неверная дата." };
  if (closed) {
    const clean = note.trim().slice(0, 200) || null;
    await prisma.morningClosure.upsert({
      where: { day },
      create: { day, note: clean, createdByUserId: user.id },
      update: { note: clean },
    });
  } else {
    await prisma.morningClosure.deleteMany({ where: { day } });
  }
  revalidatePath("/dashboard/schedule");
  return {};
}

/** Сколько баллов флорист успевает к 15:00. */
export async function setFloristMorningCapacity(floristId: string, capacity: number): Promise<{ error?: string }> {
  await requireRole("OWNER");
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > MAX_CAPACITY) return { error: `От 0 до ${MAX_CAPACITY}.` };
  await prisma.florist.update({ where: { id: floristId }, data: { morningCapacity: capacity } });
  revalidatePath("/dashboard/schedule");
  return {};
}
