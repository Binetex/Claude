"use client";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useOrdersNav, NavSpinner } from "./OrdersNav";
import { Search, SlidersHorizontal } from "lucide-react";
import { orderStatusFilterOptions, statusFilterValue } from "@/lib/statuses";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import type { OrderFilters } from "@/modules/orders/queries";

const DEFAULT_PRESETS = [
  { key: "today", label: "Сегодня" },
  { key: "tomorrow", label: "Завтра" },
  { key: "all", label: "Все" },
];

const sortOptions = [
  { value: "", label: "Сортировка: по умолчанию" },
  { value: "deliveryDate:asc", label: "Дата доставки ↑" },
  { value: "deliveryDate:desc", label: "Дата доставки ↓" },
  { value: "createdAt:asc", label: "Дата создания ↑" },
  { value: "createdAt:desc", label: "Дата создания ↓" },
  { value: "orderStatus:asc", label: "Статус ↑" },
  { value: "orderStatus:desc", label: "Статус ↓" },
];

export function OrderFiltersBar({
  sites,
  florists,
  current,
  basePath = "/dashboard/orders",
  showFloristFilter = true,
  showSiteFilter = true,
  presets = DEFAULT_PRESETS,
}: {
  sites: { id: string; name: string }[];
  florists: { id: string; name: string }[];
  current: OrderFilters;
  basePath?: string;
  showFloristFilter?: boolean;
  /** Магазин выбирает владелец и колл-центр; флористу назначают заказы, фильтр ему не нужен. */
  showSiteFilter?: boolean;
  /** Свой набор вкладок. У флориста добавляется «Готовые» (preset=done). */
  presets?: { key: string; label: string }[];
}) {
  const params = useSearchParams();
  const { pending, go } = useOrdersNav();
  const [advanced, setAdvanced] = useState(
    !!(current.status || current.siteId || current.floristId || current.date || current.sortBy)
  );

  function update(next: Record<string, string | undefined>) {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    // Любая смена фильтра — снова с первой страницы: на пятой странице «Всех» после
    // выбора «Сегодня» была бы пустота.
    p.delete("page");
    go(`${basePath}?${p.toString()}`);
  }

  // Старые ссылки с одиночным ?date= показываем как диапазон «этот день — этот день»,
  // чтобы поля не выглядели пустыми при активном фильтре.
  const rangeFrom = current.from ?? current.date ?? "";
  const rangeTo = current.to ?? current.date ?? "";

  const activePreset =
    current.preset ??
    (current.date || current.from || current.to || current.status || current.siteId || current.floristId ? "" : "today");

  return (
    <div className="space-y-2.5">
      {/* Два ряда на телефоне: вкладки занимают первый целиком, всё остальное — второй.
          Раньше строка ломалась на три ряда, потому что длинные плейсхолдеры («Даты
          доставки», «Поиск: № / имя / телефон / адрес») выталкивали поиск на свою строку. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Сегментированные вкладки */}
        <div className="flex w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-slate-100 p-0.5 md:w-auto">
          {presets.map((p) => (
            <button
              key={p.key}
              disabled={pending}
              onClick={() => update({ preset: p.key, date: undefined, from: undefined, to: undefined })}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium transition-colors disabled:cursor-not-allowed",
                activePreset === p.key ? "bg-white text-slate-900 shadow-xs" : "text-slate-500 hover:text-slate-800"
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <NavSpinner />

        {/* Диапазон дат доставки. Одна дата = кликнуть день дважды (from = to). */}
        <DateRangePicker
          value={{ from: rangeFrom || undefined, to: rangeTo || undefined }}
          disabled={pending}
          placeholder="Даты"
          onChange={(next) => update({ from: next.from, to: next.to, date: undefined, preset: undefined })}
        />

        <div className="flex flex-1 items-center gap-2 md:ml-auto md:flex-none">
          <div className="relative flex-1 md:flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="search"
              placeholder="Поиск"
              aria-label="Поиск по номеру, имени, телефону или адресу"
              defaultValue={current.search}
              onKeyDown={(e) => {
                if (e.key === "Enter") update({ search: (e.target as HTMLInputElement).value || undefined });
              }}
              className="w-full pl-8 md:w-64"
            />
          </div>
          {/* На узком экране остаётся одна иконка — подпись уезжает в aria-label, иначе
              кнопка вытесняла бы поиск на третий ряд. */}
          <Button
            variant={advanced ? "secondary" : "outline"}
            aria-label="Фильтры"
            aria-expanded={advanced}
            onClick={() => setAdvanced((v) => !v)}
          >
            <SlidersHorizontal />
            <span className="hidden sm:inline">Фильтры</span>
          </Button>
        </div>
      </div>

      {advanced && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-3">
          <Select
            // Ссылка может содержать ASSIGNED/FLORIST_ACCEPTED — в списке такого пункта нет,
            // поэтому показываем общий «В работе», иначе select молча сбросится на «Все статусы».
            value={statusFilterValue(current.status)}
            onChange={(e) => update({ status: e.target.value || undefined })}
            wrapperClassName="w-full sm:w-48"
          >
            <option value="">Все статусы</option>
            {orderStatusFilterOptions.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </Select>
          {showSiteFilter && (
            <Select
              value={current.siteId ?? ""}
              onChange={(e) => update({ siteId: e.target.value || undefined })}
              wrapperClassName="w-full sm:w-44"
            >
              <option value="">Все сайты</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          )}
          {showFloristFilter && (
            <Select
              value={current.floristId ?? ""}
              onChange={(e) => update({ floristId: e.target.value || undefined })}
              wrapperClassName="w-full sm:w-44"
            >
              <option value="">Все флористы</option>
              {florists.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          )}
          <Select
            value={current.sortBy ? `${current.sortBy}:${current.sortDir ?? "asc"}` : ""}
            onChange={(e) => {
              const [sortBy, sortDir] = e.target.value.split(":");
              update({ sortBy: sortBy || undefined, sortDir: sortDir || undefined });
            }}
            wrapperClassName="w-full sm:w-52"
          >
            {sortOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => go(basePath)}>Сбросить</Button>
        </div>
      )}
    </div>
  );
}
