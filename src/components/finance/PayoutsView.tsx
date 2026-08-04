import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { listLedgerEntries } from "@/modules/finance/ledger";
import { formatMonthTitle } from "@/modules/finance/earningsFormat";

/**
 * История выплат: когда и сколько выплатили. Один экран на кабинет флориста и на кабинет
 * того же флориста глазами владельца — числа обязаны совпадать, поэтому и запрос один.
 *
 * Только выплаты и их отмены. Начислений, бонусов и корректировок здесь нет: заработок
 * живёт на соседней вкладке и показывается днями, а не строками книги. Полная книга у
 * владельца доступна отдельной ссылкой «Все операции» и главным экраном не является.
 *
 * Отменённую выплату скрывать нельзя — деньги, которые человек считал полученными, обязаны
 * остаться видимыми вместе с отменой, иначе сумма «к выплате» изменится без объяснения.
 */
export async function PayoutsView({
  floristId,
  emptyDescription,
}: {
  floristId: string;
  emptyDescription: string;
}) {
  const list = await listLedgerEntries(floristId, { types: ["PAYMENT", "PAYMENT_REVERSAL"], perPage: 200 });

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
          <EmptyState title="Выплат пока не было" description={emptyDescription} />
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
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b border-slate-50 px-4 py-3 last:border-0"
                  >
                    <span className="text-slate-600 tabular-nums">
                      {fmtDate(e.effectiveDate)}
                      {reversal && <span className="ml-2 text-[11px] text-orange-700">отмена выплаты</span>}
                      {e.isReversed && !reversal && <span className="ml-2 text-[11px] text-orange-700">отменена</span>}
                    </span>
                    <span
                      className={`ml-auto tabular-nums font-semibold ${reversal || e.isReversed ? "text-slate-400 line-through" : "text-slate-900"}`}
                    >
                      {formatCents(e.amountCents)}
                    </span>
                    {/* Комментарий владельца — отдельной строкой во всю ширину: он длинный и
                        рядом с суммой ломал бы строку на телефоне. Показываем именно comment,
                        а не description: последний у всех выплат один и тот же («Выплата») и
                        повторялся бы в каждой строке, ничего не сообщая. */}
                    {e.comment && <span className="w-full text-xs break-words text-slate-400">{e.comment}</span>}
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
