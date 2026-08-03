"use client";
/** Размер страницы списка дней. Состояние живёт в URL — ссылку можно сохранить и переслать. */
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { PER_PAGE_OPTIONS } from "@/modules/finance/sharePaging";

export function PerPageSelect({ current }: { current: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  return (
    <label className="flex items-center gap-2 text-xs text-slate-500">
      Показывать по
      <select
        className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-sm shadow-xs"
        value={current}
        onChange={(e) => {
          const next = new URLSearchParams(sp.toString());
          next.set("perPage", e.target.value);
          // Смена размера страницы возвращает на первую: остаться на седьмой странице
          // выборки, в которой теперь две, — верный способ решить, что данные пропали.
          next.delete("page");
          router.push(`${pathname}?${next.toString()}`);
        }}
      >
        {PER_PAGE_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}
