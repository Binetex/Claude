"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { imageStorage } from "@/lib/storage";
import { createFlorist, updateFlorist, FloristValidationError } from "@/modules/florists/service";

type FormState = { error?: string; success?: true } | null;

function checkbox(v: FormDataEntryValue | null): boolean {
  return v === "on" || v === "true" || v === "1";
}

/**
 * Клиент присылает уже ужатую квадратную аватарку как data URL (см. AvatarUpload).
 * Сохраняем файл в хранилище (public/uploads) и возвращаем ССЫЛКУ. Пусто/не data URL → undefined
 * (аватарка не меняется). Сам файл в БД не кладём.
 */
async function resolveAvatar(formData: FormData): Promise<string | undefined> {
  const raw = String(formData.get("avatarDataUrl") ?? "").trim();
  if (!raw.startsWith("data:image/")) return undefined;
  return imageStorage.saveImage(raw);
}

/** Создание нового флориста (User+Florist). Пароль задаёт владелец. */
export async function ownerCreateFlorist(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole("OWNER");
  try {
    const avatarUrl = await resolveAvatar(formData);
    await createFlorist(prisma, {
      name: String(formData.get("name") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      password: String(formData.get("password") ?? ""),
      active: checkbox(formData.get("active")),
      ...(avatarUrl ? { avatarUrl } : {}),
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
    const avatarUrl = await resolveAvatar(formData);
    await updateFlorist(prisma, floristId, {
      name: String(formData.get("name") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      ...(password ? { password } : {}),
      active: checkbox(formData.get("active")),
      ...(avatarUrl ? { avatarUrl } : {}),
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

/**
 * Недоступность флориста. Три маленьких действия вместо одной формы: и выходные, и даты
 * сохраняются сразу по клику.
 *
 * День хранится как UTC-полночь календарного дня — та же конвенция, что у
 * Order.deliveryDate. Никакого перевода через таймзону: она уже учтена в дне доставки, и
 * повторный перевод сдвинул бы выходной на сутки.
 */
type AvailabilityResult = { error?: string; message?: string };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function refreshFlorists(): void {
  revalidatePath("/dashboard/florists");
}

export async function ownerSetFloristWeekends(floristId: string, days: number[]): Promise<AvailabilityResult> {
  await requireRole("OWNER");
  // Чужие числа в массив дней недели пускать нельзя: они молча никогда не совпадут.
  const clean = [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  await prisma.florist.update({ where: { id: floristId }, data: { weekendDays: clean } });
  refreshFlorists();
  return { message: "Выходные сохранены" };
}

export async function ownerAddFloristDayOff(floristId: string, day: string): Promise<AvailabilityResult> {
  await requireRole("OWNER");
  if (!DAY_RE.test(day)) return { error: "Некорректная дата." };
  const date = new Date(`${day}T00:00:00.000Z`);

  const florist = await prisma.florist.findUnique({ where: { id: floristId }, select: { daysOff: true } });
  if (!florist) return { error: "Флорист не найден." };
  if (florist.daysOff.some((d) => d.toISOString().slice(0, 10) === day)) {
    return { message: "Эта дата уже отмечена" };
  }

  await prisma.florist.update({
    where: { id: floristId },
    data: { daysOff: { set: [...florist.daysOff, date] } },
  });
  refreshFlorists();
  return { message: "Дата добавлена" };
}

export async function ownerRemoveFloristDayOff(floristId: string, day: string): Promise<AvailabilityResult> {
  await requireRole("OWNER");
  if (!DAY_RE.test(day)) return { error: "Некорректная дата." };

  const florist = await prisma.florist.findUnique({ where: { id: floristId }, select: { daysOff: true } });
  if (!florist) return { error: "Флорист не найден." };

  await prisma.florist.update({
    where: { id: floristId },
    data: { daysOff: { set: florist.daysOff.filter((d) => d.toISOString().slice(0, 10) !== day) } },
  });
  refreshFlorists();
  return { message: "Дата убрана" };
}
