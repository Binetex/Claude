"use server";
/**
 * Пересчёт одного дня. ЕДИНСТВЕННОЕ действие на странице разбора, которое пишет.
 *
 * Сам просмотр не создаёт ни снимков, ни записей книги: экран читает опубликованное.
 * Кнопка нужна тем, кому не хочется ждать очередного прохода диспетчера.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { republishAndDetect } from "@/modules/finance/fix";
import { accrueDayShare } from "@/modules/finance/primaryShare";

export async function recomputeDayAction(formData: FormData): Promise<{ error?: string; message?: string }> {
  const user = await requireRole("OWNER");
  const day = String(formData.get("day") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "Некорректная дата." };

  const profile = await prisma.floristFinanceProfile.findFirst({
    where: { model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true },
  });
  if (!profile) return { error: "Нет действующего профиля основного флориста." };

  const date = new Date(`${day}T00:00:00.000Z`);
  const actor = { userId: user.id, role: user.role };
  const r = await republishAndDetect(profile.id, [date], actor, new Date());
  const outcome = await accrueDayShare(profile.id, date, actor);

  revalidatePath(`/dashboard/finance/share/${day}`);
  revalidatePath("/dashboard/finance/share");

  const tail =
    outcome.status === "CORRECTED"
      ? " Начисление пересчитано: прежнее сторновано, создано новое."
      : outcome.status === "CREATED"
        ? " Начисление создано."
        : outcome.status === "UNCHANGED"
          ? " Начисление не изменилось."
          : ` Начисление не создано (${outcome.reason}).`;
  return { message: `Пересчитано. Ревизий снимков: ${r.republished}.${tail}` };
}
