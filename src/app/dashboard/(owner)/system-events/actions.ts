"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";

/**
 * Ручной повтор события (FAILED/DEAD_LETTER → PENDING). Только для владельца.
 * Идемпотентно и безопасно: не выполняет само действие, лишь возвращает событие в очередь —
 * его подберёт отдельный worker.
 */
export async function retryOutboxEvent(formData: FormData): Promise<void> {
  await requireRole("OWNER");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const repo = new PrismaOutboxRepository(prisma);
  await repo.requeue(id);
  revalidatePath("/dashboard/system-events");
}
