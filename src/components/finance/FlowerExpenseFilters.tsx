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
 *
 * Произвольный период выбирается тем же календарём, что и на странице заказов
 * (DateRangePicker) — второго способа задать даты в проекте быть не должно.
 */
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Select } from "@/components/ui/select";
import { DateRangePicker } from "@/components/ui/date-range-picker";

const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

const STATUSES: { value: string; label: string }[] = [
  { value: "", label: "Любой статус" },
  { value: "MISSING", label: "Отсутствует" },
  { value: "FILLED", label: "Заполнено" },
  { value: "INCOMPLETE", label: "Не хватает данных" },
  { value: "COUNTED", label: "Посчитан" },
];

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
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Период"
        wrapperClassName="w-32"
        value={period === "range" ? "month" : period}
        onChange={(e) => update({ period: e.target.value, from: null, to: null })}
      >
        <option value="month">Месяц</option>
        <option value="year">Год</option>
        <option value="all">Вся история</option>
      </Select>

      {period === "month" && (
        <Select aria-label="Месяц" wrapperClassName="w-36" value={month} onChange={(e) => update({ month: e.target.value })}>
          {MONTHS.map((m, i) => (
            <option key={m} value={i + 1}>{m}</option>
          ))}
        </Select>
      )}

      {(period === "month" || period === "year") && (
        <Select aria-label="Год" wrapperClassName="w-24" value={year} onChange={(e) => update({ year: e.target.value })}>
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </Select>
      )}

      {/* Календарь сам задаёт произвольный период: выбор дат переключает режим на «range»,
          сброс возвращает к месяцу. Отдельного пункта «Период» в списке нет — он был бы
          вторым способом сделать ровно то же самое. */}
      <DateRangePicker
        placeholder="Выбрать даты"
        value={{ from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }}
        onChange={(next) =>
          next.from || next.to
            ? update({ period: "range", from: next.from ?? null, to: next.to ?? null })
            : update({ period: "month", from: null, to: null })
        }
      />

      <Select
        aria-label="Статус"
        wrapperClassName="w-48"
        value={sp.get("status") ?? ""}
        onChange={(e) => update({ status: e.target.value })}
      >
        {STATUSES.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </Select>
    </div>
  );
}
