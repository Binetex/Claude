"use client";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { setOrderPickupLocationAction } from "./deliveryActions";

export type OrderPickupOption = {
  id: string;
  locationName: string;
  addressLine: string;
  city: string;
  state: string;
  zip: string;
};

export type OrderPickupData = {
  orderId: string;
  /** Точки назначенного флориста, доступные для выбора (только активные). */
  options: OrderPickupOption[];
  /** Точка, которая действует сейчас (null — ни одной пригодной нет). */
  currentId: string | null;
  /** Точка выбрана вручную для этого заказа, а не взята как основная у флориста. */
  isOverride: boolean;
  /** У заказа нет назначенного флориста. */
  noFlorist: boolean;
  /** Есть активная доставка Burq — переключение её пересоздаст. */
  hasActiveDelivery: boolean;
};

/**
 * Точка забора конкретного заказа. Переключение доступно любому сотруднику: точка меняется
 * СРАЗУ, и если Burq-черновик уже создан (но ещё не оформлен) — он удаляется и создаётся
 * заново с новой точкой. Смена ОСНОВНОЙ точки флориста в его кабинете, наоборот, на уже
 * созданные доставки не влияет.
 */
export function OrderPickupSwitcher({ data }: { data: OrderPickupData }) {
  const [state, action, pending] = useActionState(setOrderPickupLocationAction, null);
  const [selected, setSelected] = useState(data.currentId ?? "");
  // После сохранения страница перерисовывается с новой действующей точкой — селект обязан
  // показать её, иначе он продолжает предлагать прежнюю и кнопка выглядит «ничего не делает».
  // Правка состояния прямо в рендере (а не в эффекте) — рекомендованный React способ
  // сбросить состояние при смене пропа: лишнего прохода рендера не будет.
  const [syncedTo, setSyncedTo] = useState(data.currentId);
  if (syncedTo !== data.currentId) {
    setSyncedTo(data.currentId);
    setSelected(data.currentId ?? "");
  }
  const current = data.options.find((o) => o.id === data.currentId) ?? null;
  const changed = (data.currentId ?? "") !== selected;

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <div className="font-medium text-slate-700">Точка забора</div>

      {data.noFlorist ? (
        <p className="mt-1 text-xs text-amber-600">Флорист не назначен — точка появится после назначения.</p>
      ) : current ? (
        <p className="mt-1 text-xs text-slate-500">
          {current.locationName} · {current.addressLine}, {current.city} {current.state} {current.zip}
          <span className="text-slate-400"> · {data.isOverride ? "выбрана вручную для этого заказа" : "основная точка флориста"}</span>
        </p>
      ) : (
        <p className="mt-1 text-xs text-amber-600">У флориста нет активной точки забора — доставка не создаётся.</p>
      )}

      {data.options.length > 1 && (
        <form action={action} className="mt-2 space-y-2">
          <input type="hidden" name="orderId" value={data.orderId} />
          <select
            name="pickupLocationId"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
          >
            <option value="">Основная точка флориста</option>
            {data.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.locationName} — {o.addressLine}, {o.city}
              </option>
            ))}
          </select>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            /* Подпись длинная («Переключить точку и пересоздать доставку») и у кнопок дизайн-системы
               стоит whitespace-nowrap — на телефоне она вылезала за экран. Здесь текст переносится,
               а высота задаётся содержимым. */
            className="h-auto w-full py-1.5 text-center whitespace-normal sm:w-auto"
            disabled={pending || !changed}
            onClick={(e) => {
              if (data.hasActiveDelivery && !confirm("Доставка Burq будет отменена и создана заново с новой точкой. Продолжить?")) {
                e.preventDefault();
              }
            }}
          >
            {pending ? "…" : data.hasActiveDelivery ? "Переключить точку и пересоздать доставку" : "Переключить точку"}
          </Button>
          {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
          {state?.ok && <p className="text-xs text-emerald-700">{state.message}</p>}
        </form>
      )}
    </div>
  );
}
