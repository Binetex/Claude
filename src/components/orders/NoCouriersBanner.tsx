import "server-only";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { prisma } from "@/lib/db";
import { fmtDate } from "@/lib/format";

/**
 * «На эти заказы Burq не нашёл курьеров» — баннер на ГЛАВНОЙ странице заказов.
 *
 * Снаружи карточки заказа СОЗНАТЕЛЬНО: внутрь заходят, когда с заказом уже работают, а
 * узнать про отсутствие курьеров надо раньше — чтобы успеть передать заказ другому флористу
 * или везти самим. Внутри карточки эта же информация не дублируется.
 *
 * Показывается ТОЛЬКО когда есть что сказать: курьеры нашлись — блока нет вовсе.
 * `couriersAvailable = NULL` («не проверяли») сюда не попадает: молчание проверки не повод
 * поднимать тревогу.
 *
 * Проверка делается в момент создания черновика — ночью, — поэтому в тексте прямо сказано,
 * что к моменту доставки курьеры могут появиться. Без этой оговорки баннер читается как
 * приговор и быстро приучает себя игнорировать.
 */
export async function NoCouriersBanner({
  floristId,
  hrefBase,
}: {
  /** Кабинет флориста — только его заказы. У владельца не задаётся: он видит все. */
  floristId?: string;
  /** Куда ведёт клик по заказу: /dashboard/orders у владельца, /dashboard/f у флориста. */
  hrefBase: string;
}) {
  const orders = await prisma.order.findMany({
    where: {
      ...(floristId ? { currentFloristId: floristId } : {}),
      orderStatus: { notIn: ["DELIVERED", "CANCELLED"] },
      deliveries: { some: { isCurrentAttempt: true, couriersAvailable: 0 } },
    },
    select: {
      id: true,
      orderNumber: true,
      deliveryDate: true,
      recipientName: true,
      city: true,
      deliveries: {
        where: { isCurrentAttempt: true },
        select: { couriersCheckedAt: true },
        take: 1,
      },
    },
    orderBy: { deliveryDate: "asc" },
    take: 20,
  });

  if (orders.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-amber-900">
            Burq не нашёл курьеров: {orders.length}{" "}
            {orders.length === 1 ? "заказ" : orders.length < 5 ? "заказа" : "заказов"}
          </div>
          <ul className="mt-1.5 space-y-1">
            {orders.map((o) => {
              const checked = o.deliveries[0]?.couriersCheckedAt ?? null;
              return (
                <li key={o.id}>
                  <Link
                    href={`${hrefBase}/${o.id}`}
                    className="flex flex-wrap items-baseline gap-x-2 text-sm text-amber-900 hover:underline"
                  >
                    <span className="font-medium">{o.orderNumber}</span>
                    <span className="text-amber-800">
                      {o.recipientName}
                      {o.city ? `, ${o.city}` : ""}
                    </span>
                    <span className="text-xs text-amber-700">доставка {fmtDate(o.deliveryDate)}</span>
                    {checked && (
                      <span className="text-xs text-amber-600">
                        проверено {checked.toISOString().slice(11, 16)}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-amber-700">
            Проверка сделана при создании черновика. Ближе к доставке курьеры могут появиться —
            но если заказ срочный, стоит решить заранее.
          </p>
        </div>
      </div>
    </div>
  );
}
