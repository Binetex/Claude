"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { createFlorist, updateFlorist, FloristValidationError } from "@/modules/florists/service";

type FormState = { error?: string; success?: true } | null;

function checkbox(v: FormDataEntryValue | null): boolean {
  return v === "on" || v === "true" || v === "1";
}

/** Создание нового флориста (User+Florist). Пароль задаёт владелец. */
export async function ownerCreateFlorist(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole("OWNER");
  try {
    await createFlorist(prisma, {
      name: String(formData.get("name") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      password: String(formData.get("password") ?? ""),
      active: checkbox(formData.get("active")),
    });
  } catch (e) {
    if (e instanceof FloristValidationError) return { error: e.message };
    throw e;
  }
  revalidatePath("/dashboard/florists");
  return { success: true };
}

/** Редактирование флориста без создания нового пользователя. Пустой пароль → не меняется. */
export async function ownerUpdateFlorist(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole("OWNER");
  const floristId = String(formData.get("floristId") ?? "");
  if (!floristId) return { error: "Не указан флорист." };
  const password = String(formData.get("password") ?? "");
  try {
    await updateFlorist(prisma, floristId, {
      name: String(formData.get("name") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      ...(password ? { password } : {}),
      active: checkbox(formData.get("active")),
    });
  } catch (e) {
    if (e instanceof FloristValidationError) return { error: e.message };
    throw e;
  }
  revalidatePath("/dashboard/florists");
  return { success: true };
}

/** Быстрое включение/выключение флориста (Active/Inactive) без открытия формы редактирования. */
export async function ownerSetFloristActive(floristId: string, active: boolean): Promise<FormState> {
  await requireRole("OWNER");
  try {
    await updateFlorist(prisma, floristId, { active });
  } catch (e) {
    if (e instanceof FloristValidationError) return { error: e.message };
    throw e;
  }
  revalidatePath("/dashboard/florists");
  return { success: true };
}
