"use client";
/**
 * Фильтры истории расходов.
 *
 * По умолчанию открыт текущий месяц, но «Вся история» — равноправный пункт того же
 * списка, а не спрятанная возможность: данные старше месяца никуда не деваются, и
 * добраться до них должно быть одним движением.
 *
 * Состояние живёт в URL, а не в компоненте: ссылку на конкретный месяц можно сохранить
 * и переслать, а «назад» в браузере работает как ожидается.
 */
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

const STATUSES: { value: string; label: string }[] = [
  { value: "", label: "Любой статус" },
  { value: "MISSING", label: "Отсутствует" },
  { value: "FILLED", label: "Заполнено" },
  { value: "NEEDS_CHECK", label: "Требует проверки" },
  { value: "USED", label: "Использовано в расчёте" },
];

const selectCls = "h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-sm shadow-xs";

export function FlowerExpenseFilters({ years }: { years: number[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const period = sp.get("period") ?? "month";
  const year = sp.get("year") ?? String(new Date().getUTCFullYear());
  const month = sp.get("month") ?? String(new Date().getUTCMonth() + 1);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    // Любая смена фильтра возвращает на первую страницу: остаться на седьмой странице
    // выборки, в которой теперь две, — верный способ решить, что данные пропали.
    next.delete("page");
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <select className={selectCls} value={period} onChange={(e) => update({ period: e.target.value })}>
        <option value="month">Месяц</option>
        <option value="year">Год</option>
        <option value="range">Период</option>
        <option value="all">Вся история</option>
      </select>

      {period === "month" && (
        <>
          <select className={selectCls} value={month} onChange={(e) => update({ month: e.target.value })}>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
          <select className={selectCls} value={year} onChange={(e) => update({ year: e.target.value })}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </>
      )}

      {period === "year" && (
        <select className={selectCls} value={year} onChange={(e) => update({ year: e.target.value })}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      )}

      {period === "range" && (
        <>
          <Input
            type="date"
            className="h-9 w-auto"
            defaultValue={sp.get("from") ?? ""}
            onChange={(e) => update({ from: e.target.value })}
          />
          <Input
            type="date"
            className="h-9 w-auto"
            defaultValue={sp.get("to") ?? ""}
            onChange={(e) => update({ to: e.target.value })}
          />
        </>
      )}

      <select className={selectCls} value={sp.get("status") ?? ""} onChange={(e) => update({ status: e.target.value })}>
        {STATUSES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>

      <form
        className="flex items-end gap-2"
        action={(fd) => update({ q: String(fd.get("q") ?? "").trim() || null })}
      >
        <Input name="q" placeholder="Поиск по комментарию" className="h-9 w-52" defaultValue={sp.get("q") ?? ""} />
        <Button type="submit" size="sm" variant="outline">
          Найти
        </Button>
      </form>
    </div>
  );
}
