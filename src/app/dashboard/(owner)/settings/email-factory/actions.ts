"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { saveEmailFactoryToken, clearEmailFactoryToken } from "@/integrations/emailFactory/token";

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
