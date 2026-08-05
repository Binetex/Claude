"use client";
/**
 * Выбор месяца. Тот же принцип, что у «Расходов на цветы»: состояние живёт в URL, поэтому
 * ссылку на конкретный месяц можно сохранить, а «назад» работает как ожидается.
 *
 * Здесь только месяц и год — ни «всей истории», ни произвольного периода: таблица этого
 * раздела по устройству месячная (строка = день месяца), и в годовом окне она превратилась
 * бы в 365 строк, отвечающих уже на другой вопрос.
 */
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Select } from "@/components/ui/select";

const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

export function ExpenseFilters({ years }: { years: number[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const now = new Date();
  const year = sp.get("year") ?? String(now.getUTCFullYear());
  const month = sp.get("month") ?? String(now.getUTCMonth() + 1);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label="Месяц" wrapperClassName="w-36" value={month} onChange={(e) => update({ month: e.target.value })}>
        {MONTHS.map((m, i) => (
          <option key={m} value={i + 1}>{m}</option>
        ))}
      </Select>
      <Select aria-label="Год" wrapperClassName="w-24" value={year} onChange={(e) => update({ year: e.target.value })}>
        {years.map((y) => (
          <option key={y} value={y}>{y}</option>
        ))}
      </Select>
    </div>
  );
}
