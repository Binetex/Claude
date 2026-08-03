import { requireFlorist } from "@/lib/rbac";
import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { listLedgerEntries } from "@/modules/finance/ledger";
import { formatMonthTitle } from "@/modules/finance/earningsFormat";

export const dynamic = "force-dynamic";

/**
 * История выплат: когда и сколько мне выплатили. Один экран — один вопрос.
 *
 * Только выплаты и их отмены. Начислений, бонусов и корректировок здесь нет: заработок
 * живёт на соседней вкладке и показывается заказами, а не строками книги.
 *
 * Отменённую выплату скрывать нельзя — деньги, которые человек считал полученными, обязаны
 * остаться видимыми вместе с отменой, иначе сумма «к выплате» изменится без объяснения.
 */
export default async function FloristPayoutsPage() {
  const user = await requireFlorist();
  const list = await listLedgerEntries(user.floristId, { types: ["PAYMENT", "PAYMENT_REVERSAL"], perPage: 200 });

  // Группировка по месяцам: записи уже отсортированы по убыванию даты, поэтому достаточно
  // помечать строку, у которой месяц отличается от предыдущей.
  const groups: Array<{ title: string; rows: typeof list.entries }> = [];
  for (const e of list.entries) {
    const title = formatMonthTitle(e.effectiveDate);
    const last = groups[groups.length - 1];
    if (last && last.title === title) last.rows.push(e);
    else groups.push({ title, rows: [e] });
  }

  const fmtDate = (d: Date) => {
    const [y, m, day] = d.toISOString().slice(0, 10).split("-");
    return `${day}.${m}.${y}`;
  };

  if (list.entries.length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState title="Выплат пока не было" description="Здесь появятся выплаты, когда владелец их внесёт." />
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <Card key={g.title}>
          <CardBody className="p-0">
            <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-800">{g.title}</div>
            <ul>
              {g.rows.map((e) => {
                const reversal = e.type === "PAYMENT_REVERSAL";
                return (
                  <li
                    key={e.id}
                    className="flex items-center justify-between gap-3 border-b border-slate-50 px-4 py-3 last:border-0"
                  >
                    <span className="text-slate-600 tabular-nums">
                      {fmtDate(e.effectiveDate)}
                      {reversal && <span className="ml-2 text-[11px] text-orange-700">отмена выплаты</span>}
                      {e.isReversed && !reversal && <span className="ml-2 text-[11px] text-orange-700">отменена</span>}
                    </span>
                    <span
                      className={`tabular-nums font-semibold ${reversal || e.isReversed ? "text-slate-400 line-through" : "text-slate-900"}`}
                    >
                      {formatCents(e.amountCents)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
