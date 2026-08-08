import "server-only";
/**
 * Пересчёт итога дня, когда изменился САМ ЗАКАЗ, а не финансовая настройка.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ТОЧКА. `recalculateAffectedFinance` вызывается из правок входных данных
 * (закупка цветов, стоимость доставки, ставки) — там профиль и дни известны вызывающему.
 * А когда заказ становится доставленным или переезжает на другую дату, пересчёт нужен там,
 * где о финансах не знают вовсе: в приёме заказа, в вебхуке курьера, в правке карточки.
 * Этот модуль — их единственная дверь: он сам находит профиль основного флориста, сам
 * решает, нужен ли пересчёт, и сам всё проглатывает при ошибке.
 *
 * ПОЧЕМУ ТИХО. Финансы не должны ломать работу с заказом. Если пересчёт упал — курьерский
 * вебхук всё равно обязан примениться, а заказ сохраниться. Поэтому ошибка только логируется:
 * итог дня выводится из данных и пересчитается при следующем изменении.
 *
 * ЧТО СЧИТАЕТСЯ ЗАТРОНУТЫМ. Пересчитывается ДЕНЬ профиля основного флориста целиком — он и
 * так собирается заново из всех его доставленных заказов за эту дату (`gatherDayOrders`).
 *
 * Проверять «а этот ли заказ принадлежит основному флористу» здесь СПЕЦИАЛЬНО не стали.
 * Такая проверка выглядит экономной и ошибается на переназначении: заказ уходит от основного
 * флориста к другому, текущий владелец заказа уже не основной — и день основного остался бы
 * с устаревшим составом. Лишний пересчёт стоит несколько запросов, пропущенный — неверный
 * заработок, о котором никто не узнает.
 *
 * При переносе даты пересчитать нужно ОБА дня: и откуда заказ ушёл, и куда пришёл.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { recalculateAffectedFinance } from "./fix";
import { primaryShareGate } from "./config";

function log(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event, ...data }));
}

/**
 * Пересчитывает дни, затронутые изменением заказа.
 *
 * `days` — дни доставки, которых касается изменение. Обычно один; при переносе даты два.
 * Дубли и дни до старта расчёта отсекаются здесь, вызывающему об этом думать не нужно.
 */
export async function recomputeDaysForOrder(
  prisma: PrismaClient,
  orderId: string,
  days: Date[]
): Promise<void> {
  try {
    const gate = primaryShareGate();
    if (!gate.enabled) return;

    // Профиль основного флориста один на бизнес; дневной итог есть только у него.
    const profile = await prisma.floristFinanceProfile.findFirst({
      where: { model: "PRIMARY", active: true, effectiveTo: null },
      select: { id: true },
    });
    if (!profile) return;

    // Дни до старта расчёта не трогаем — как и везде в модуле.
    const unique = [...new Map(days.map((d) => [d.toISOString(), d])).values()].filter((d) => d >= gate.startDate);
    if (unique.length === 0) return;

    // Пересчёт подписывается владельцем: аноним в финансовых данных недопустим.
    const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true }, select: { id: true } });
    if (!owner) return;

    const r = await recalculateAffectedFinance(
      profile.id,
      unique,
      { userId: owner.id, role: "OWNER" },
      new Date()
    );
    log("finance.day.recomputed", {
      orderId,
      days: unique.map((d) => d.toISOString().slice(0, 10)),
      complete: r.complete,
    });
  } catch (err) {
    // Тихо: пересчёт не имеет права ронять приём заказа или вебхук курьера.
    log("finance.day.recompute.failed", {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Частый случай: изменился один заказ, дата не менялась. */
export async function recomputeDayForOrder(prisma: PrismaClient, orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { deliveryDate: true } });
  if (!order) return;
  await recomputeDaysForOrder(prisma, orderId, [order.deliveryDate]);
}
