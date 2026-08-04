"use client";
import { useSearchParams } from "next/navigation";
import { useOrdersNav, NavSpinner } from "@/app/dashboard/(owner)/orders/OrdersNav";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { cn } from "@/lib/cn";

/**
 * Выбор периода на экране заработка. Один на кабинет флориста и на кабинет флориста
 * глазами владельца — отсюда basePath: адрес экрана задаёт страница, а не компонент.
 *
 * Оформление и поведение — те же, что в фильтрах заказов: сегментированные вкладки плюс
 * календарь-поповер (`DateRangePicker`). Заводить здесь свой набор пилюль и своё поле дат
 * означало бы два разных языка для одного и того же действия в соседних разделах.
 *
 * Переход обёрнут в useOrdersNav: страница force-dynamic, и без видимого ожидания клик по
 * вкладке выглядит так, будто ничего не произошло. Хук работает и без провайдера.
 */
const PRESETS = [
  { key: "today", label: "Сегодня" },
  { key: "yesterday", label: "Вчера" },
  { key: "week", label: "Неделя" },
  { key: "month", label: "Месяц" },
];

export function EarningsPeriodBar({ activeKey, basePath }: { activeKey: string; basePath: string }) {
  const params = useSearchParams();
  const { pending, go } = useOrdersNav();

  function update(next: Record<string, string | undefined>) {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const s = p.toString();
    go(`${basePath}${s ? `?${s}` : ""}`);
  }

  const from = params.get("from") ?? undefined;
  const to = params.get("to") ?? undefined;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            disabled={pending}
            onClick={() => update({ period: p.key, from: undefined, to: undefined })}
            className={cn(
              "rounded-md px-3 py-1 text-sm font-medium transition-colors disabled:cursor-not-allowed",
              activeKey === p.key ? "bg-white text-slate-900 shadow-xs" : "text-slate-500 hover:text-slate-800"
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <NavSpinner />

      {/* Один день = кликнуть по дате дважды (from = to) — как в фильтрах заказов. */}
      <DateRangePicker
        value={{ from, to }}
        disabled={pending}
        placeholder="Выбрать даты"
        onChange={(next) =>
          next.from || next.to
            ? update({ period: "custom", from: next.from, to: next.to })
            : update({ period: "month", from: undefined, to: undefined })
        }
      />
    </div>
  );
}
