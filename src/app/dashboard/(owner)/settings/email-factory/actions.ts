"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { saveEmailFactoryToken, clearEmailFactoryToken, resolveEmailFactoryToken } from "@/integrations/emailFactory/token";
import { runEmailFactoryProbe, type ProbeResult } from "@/integrations/emailFactory/probe";

export type ActionResult = { ok?: true; message?: string; error?: string };

const PATH = "/dashboard/settings/email-factory";

export async function ownerSaveEmailFactoryToken(token: string): Promise<ActionResult> {
  await requireRole("OWNER");
  const res = await saveEmailFactoryToken(prisma, token);
  if ("error" in res) return { error: res.error };
  revalidatePath(PATH);
  return { ok: true, message: "Токен сохранён." };
}

export async function ownerClearEmailFactoryToken(): Promise<ActionResult> {
  await requireRole("OWNER");
  await clearEmailFactoryToken(prisma);
  revalidatePath(PATH);
  return { ok: true, message: "Токен удалён." };
}

/**
 * Разведка API. Токен берётся из хранилища и НЕ передаётся из браузера — иначе он ходил бы по
 * сети в открытом виде ради диагностики. Наружу возвращаются только имена полей и коды ответов.
 */
export async function ownerProbeEmailFactory(
  sampleAddress: string
): Promise<{ results?: ProbeResult[]; error?: string }> {
  await requireRole("OWNER");
  const token = await resolveEmailFactoryToken(prisma);
  if (!token) return { error: "Токен не задан или не расшифровывается." };
  return { results: await runEmailFactoryProbe(token, sampleAddress) };
}
