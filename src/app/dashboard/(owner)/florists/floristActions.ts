"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { imageStorage } from "@/lib/storage";
import { createFlorist, updateFlorist, FloristValidationError } from "@/modules/florists/service";
import { normalizeTelegramHandle } from "@/lib/telegramHandle";

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

/**
 * Во сколько флорист начинает собирать букеты (минуты от полуночи, по получасу). От этого часа
 * считается его расписание: «График доставки» и самое раннее время, которое называет ассистент.
 */
export async function ownerSetFloristWorkStart(floristId: string, workStartMin: number): Promise<{ error?: string }> {
  await requireRole("OWNER");
  if (!Number.isInteger(workStartMin) || workStartMin < 6 * 60 || workStartMin > 14 * 60 || workStartMin % 30) return { error: "С 6:00 до 14:00 по получасу." };
  await prisma.florist.update({ where: { id: floristId }, data: { workStartMin } });
  revalidatePath("/dashboard/florists");
  revalidatePath("/dashboard/schedule");
  return {};
}

/**
 * Доля флориста от цены букета на сайте, в процентах (владелец 10.10.2026: Арине — 60%). null —
 * цена из каталога, как у всех. Действует на заказы, назначенные ПОСЛЕ изменения: цена флориста
 * записывается в заказ при назначении, уже назначенные не пересчитываются.
 */
export async function ownerSetFloristBouquetShare(floristId: string, percent: number | null): Promise<{ error?: string }> {
  await requireRole("OWNER");
  if (percent != null && (!Number.isInteger(percent) || percent < 1 || percent > 100)) return { error: "Доля — целое число от 1 до 100." };
  await prisma.florist.update({ where: { id: floristId }, data: { bouquetSharePercentBp: percent == null ? null : percent * 100 } });
  revalidatePath("/dashboard/florists");
  return {};
}

/** Ник флориста в Telegram — им её отмечают в срочных уведомлениях о доставке. Пусто — убрать. */
export async function ownerSetFloristTelegram(floristId: string, raw: string): Promise<{ error?: string; value?: string | null }> {
  await requireRole("OWNER");
  const handle = normalizeTelegramHandle(raw);
  if (handle === undefined) return { error: "Ник — латиница, цифры и «_», от 5 символов (например @arina_flowers)." };
  const florist = await prisma.florist.findUnique({ where: { id: floristId }, select: { userId: true } });
  if (!florist) return { error: "Флорист не найден." };
  await prisma.user.update({ where: { id: florist.userId }, data: { telegramId: handle } });
  revalidatePath("/dashboard/florists");
  return { value: handle };
}
