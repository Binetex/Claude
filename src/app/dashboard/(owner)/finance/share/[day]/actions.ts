"use server";
/**
 * Пересчёт одного дня. ЕДИНСТВЕННОЕ действие на странице разбора, которое пишет.
 *
 * Сам просмотр ничего не пишет: экран читает записанный итог дня. Кнопка нужна тем, кому
 * не хочется ждать очередного прохода диспетчера.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { recalculateAffectedFinance } from "@/modules/finance/fix";
import { computeDayShare } from "@/modules/finance/dayFinance";

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
  await recalculateAffectedFinance(profile.id, [date], actor, new Date());
  const share = await computeDayShare(profile.id, date);

  revalidatePath(`/dashboard/finance/share/${day}`);
  revalidatePath("/dashboard/finance/share");

  return {
    message: share?.complete
      ? `Пересчитано. Заработок флориста за день: ${(share.shareCents / 100).toFixed(2)}.`
      : "Пересчитано. День посчитан не целиком — не хватает данных по заказам.",
  };
}
