"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardBody } from "@/components/ui/Card";
import { ownerSetConsumableUsage } from "./actions";

export type RowItem = { id: string; name: string; imageUrl: string | null; isAuto: boolean };
export type RowOrder = {
  orderId: string;
  orderNumber: string;
  siteName: string;
  floristName: string | null;
  productSummary: string;
  photoUrl: string | null;
  unknownVases: number;
  auto: Record<string, number>;
  manual: Record<string, number>;
};

/**
 * Одна строка дня: фото букета, чем заказ отличается от соседнего, и что в него положили.
 *
 * Посчитанное правилом показано плашками — их не надо трогать. Ручные позиции (коробки, конверты)
 * — кнопки в одно нажатие: нажал — положили одну, нажал ещё раз — снял (владелец 10.10.2026: «чтобы
 * всё было удобно»). Больше одной и любое другое число — по кнопке «поправить».
 */
export function OrderConsumablesRow({ order, items }: { order: RowOrder; items: RowItem[] }) {
  const [manual, setManual] = useState<Record<string, number>>(order.manual);
  const [openAll, setOpenAll] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const valueOf = (id: string) => manual[id] ?? order.auto[id] ?? 0;
  const isManual = (id: string) => Object.prototype.hasOwnProperty.call(manual, id);

  function save(itemId: string, raw: string) {
    const trimmed = raw.trim();
    const quantity = trimmed === "" ? null : Number(trimmed);
    if (quantity !== null && (!Number.isInteger(quantity) || quantity < 0)) return;
    start(async () => {
      await ownerSetConsumableUsage({ orderId: order.orderId, itemId, quantity });
      setManual((prev) => {
        const next = { ...prev };
        if (quantity === null) delete next[itemId];
        else next[itemId] = quantity;
        return next;
      });
      // Итог дня и «не отмечено» сверху считает сервер — перечитываем страницу.
      router.refresh();
    });
  }

  const manualItems = items.filter((i) => !i.isAuto);
  const autoWithValue = items.filter((i) => i.isAuto && valueOf(i.id) > 0);
  const nothingMarked = manualItems.length > 0 && manualItems.every((i) => valueOf(i.id) === 0);

  return (
    <Card className={nothingMarked ? "border-amber-200" : undefined}>
      <CardBody className="flex flex-wrap items-start gap-3 py-3">
        {/* Обычный <img>: карточка не ссылка целиком, лайтбокс здесь только мешал бы. */}
        {order.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={order.photoUrl} alt="" className="size-14 shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[10px] text-slate-400">
            без фото
          </div>
        )}

        <div className="min-w-[12rem] flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/dashboard/orders/${order.orderId}`} className="text-sm font-medium text-sky-700 hover:underline">
              {order.orderNumber}
            </Link>
            <Badge className="border-slate-200 bg-slate-50 text-slate-600">{order.siteName}</Badge>
            {order.floristName && <span className="text-[11px] text-slate-400">{order.floristName}</span>}
            {nothingMarked && <Badge className="border-amber-200 bg-amber-50 text-amber-800">не отмечено</Badge>}
            {order.unknownVases > 0 && (
              <Badge className="border-amber-200 bg-amber-50 text-amber-700">ваза без типа</Badge>
            )}
          </div>
          <div className="line-clamp-2 text-xs text-slate-500">{order.productSummary}</div>
          {autoWithValue.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 pt-0.5">
              {autoWithValue.map((i) => (
                <Badge
                  key={i.id}
                  className={
                    isManual(i.id)
                      ? "border-slate-300 bg-white text-slate-700"
                      : "border-emerald-200 bg-emerald-50 text-emerald-700"
                  }
                >
                  {i.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={i.imageUrl} alt="" className="mr-1 size-4 rounded object-cover" />
                  )}
                  {i.name}
                  {valueOf(i.id) > 1 ? ` ×${valueOf(i.id)}` : ""}
                  {isManual(i.id) && " · вручную"}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {manualItems.map((i) => {
            const n = valueOf(i.id);
            return (
              <button
                key={i.id}
                type="button"
                disabled={pending}
                onClick={() => save(i.id, n > 0 ? "" : "1")}
                className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition disabled:opacity-50 ${
                  n > 0 ? "border-sky-300 bg-sky-50 font-medium text-sky-800" : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {i.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={i.imageUrl} alt="" className="size-4 rounded object-cover" />
                )}
                {n > 0 ? "✓ " : ""}
                {i.name}
                {n > 1 ? ` ×${n}` : ""}
              </button>
            );
          })}
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpenAll((v) => !v)}>
            {openAll ? "свернуть" : "поправить"}
          </Button>
        </div>

        {openAll && (
          <div className="w-full border-t border-slate-100 pt-3">
            <div className="mb-1 text-[11px] text-slate-400">
              Пусто — действует расчёт по заказу. Введите своё число, чтобы перебить его; сотрите — вернётся расчёт.
            </div>
            <div className="flex flex-wrap gap-2">
              {items.map((i) => (
                <label key={i.id} className="flex flex-col gap-0.5 text-[11px] text-slate-500">
                  <span className="flex items-center gap-1">
                    {i.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={i.imageUrl} alt="" className="size-4 rounded object-cover" />
                    )}
                    {i.name}
                  </span>
                  <Input
                    // Ключ по значению: кнопка сверху поменяла число — поле показывает новое, а не старое.
                    key={`${i.id}:${manual[i.id] ?? ""}`}
                    inputMode="numeric"
                    defaultValue={isManual(i.id) ? String(manual[i.id]) : ""}
                    placeholder={order.auto[i.id] ? String(order.auto[i.id]) : "—"}
                    disabled={pending}
                    onBlur={(e) => save(i.id, e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    className="h-8 w-16 text-right text-xs tabular-nums"
                  />
                </label>
              ))}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
