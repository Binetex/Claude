"use client";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useOrdersNav } from "./OrdersNav";
import { PER_PAGE_OPTIONS, DEFAULT_PER_PAGE } from "./paging";

/**
 * Пейджер списка заказов. Страница и размер страницы живут в URL, поэтому ссылку на конкретную
 * страницу можно переслать, а «назад» в браузере работает ожидаемо.
 */
export function OrdersPager({
  page,
  perPage,
  total,
  basePath = "/dashboard/orders",
}: {
  page: number;
  perPage: number;
  total: number;
  basePath?: string;
}) {
  const params = useSearchParams();
  const { pending, go } = useOrdersNav();

  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);

  function navigate(next: { page?: number; perPage?: number }) {
    const p = new URLSearchParams(params.toString());
    if (next.perPage !== undefined) {
      p.set("perPage", String(next.perPage));
      p.delete("page"); // смена размера страницы сбрасывает на первую — иначе можно улететь за конец
    }
    if (next.page !== undefined) {
      if (next.page <= 1) p.delete("page");
      else p.set("page", String(next.page));
    }
    go(`${basePath}?${p.toString()}`);
  }

  // Одна страница и размер по умолчанию — пейджер только мешает.
  if (total <= perPage && perPage === DEFAULT_PER_PAGE) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
      <div className="text-xs text-slate-500">
        {total === 0 ? "Ничего не найдено" : `${from}–${to} из ${total}`}
      </div>

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-slate-500">
          На странице
          <Select
            value={String(perPage)}
            disabled={pending}
            onChange={(e) => navigate({ perPage: Number(e.target.value) })}
            wrapperClassName="w-20"
          >
            {PER_PAGE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </Select>
        </label>

        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || page <= 1}
            onClick={() => navigate({ page: page - 1 })}
          >
            Назад
          </Button>
          <span className="px-1 text-xs text-slate-500 tabular-nums">
            {page} / {lastPage}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || page >= lastPage}
            onClick={() => navigate({ page: page + 1 })}
          >
            Вперёд
          </Button>
        </div>
      </div>
    </div>
  );
}
