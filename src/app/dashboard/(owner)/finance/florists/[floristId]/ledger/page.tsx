import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { LedgerTable } from "@/components/finance/LedgerTable";
import { listLedgerEntries } from "@/modules/finance/ledger";
import { REVERSIBLE_TYPES } from "@/modules/finance/ledgerRules";
import { ReverseEntryButton } from "../FinanceForms";
import { LedgerFilters } from "./LedgerFilters";
import type { LedgerEntryType } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

const PER_PAGE = 50;

/**
 * Полная книга операций флориста — СПРАВОЧНЫЙ экран, не главный.
 *
 * Раньше он и был кабинетом флориста у владельца: пять технических показателей плюс таблица
 * всех записей с фильтром по типам. Человек приходил узнать «сколько мы должны», а видел
 * бухгалтерию. Теперь кабинет — это заработок и выплаты (те же экраны, что у флориста), а
 * книга живёт здесь и открывается ссылкой «Все операции».
 *
 * Сводки баланса тут намеренно нет: она уже стоит карточкой «К выплате» на заработке, и
 * второй её экземпляр с другим набором слагаемых — ровно тот случай, когда два экрана про
 * одни деньги начинают расходиться.
 */

/** Дата фильтра из URL. Мусор игнорируем молча — фильтр не повод для ошибки страницы. */
function parseDate(v: string | undefined): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function FloristLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ floristId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole("OWNER");
  const { floristId } = await params;
  const sp = await searchParams;

  const from = parseDate(sp.from);
  const to = parseDate(sp.to);
  const types = sp.type ? ([sp.type] as LedgerEntryType[]) : undefined;
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);

  const list = await listLedgerEntries(floristId, { from, to, types, page, perPage: PER_PAGE });

  const base = `/dashboard/finance/florists/${floristId}/ledger`;
  const totalPages = Math.max(Math.ceil(list.total / PER_PAGE), 1);
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ from: sp.from, to: sp.to, type: sp.type, page: sp.page, ...patch })) {
      if (v) p.set(k, v);
    }
    const s = p.toString();
    return `${base}${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <Link
        href={`/dashboard/finance/florists/${floristId}`}
        className="inline-flex text-sm text-slate-500 hover:text-slate-900"
      >
        ← К заработку
      </Link>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Все операции · {list.total}</CardTitle>
          <LedgerFilters floristId={floristId} from={sp.from} to={sp.to} type={sp.type} />
        </CardHeader>
        <CardBody className="p-0 px-4">
          <LedgerTable
            rows={list.entries}
            orderHrefBase="/dashboard/orders"
            actions={(row) =>
              // Отменять можно только «содержательные» операции и только один раз.
              // Сторно сторна не бывает: для правки создаётся новая операция.
              !row.isReversed && !row.isReversal && REVERSIBLE_TYPES.includes(row.type) ? (
                <ReverseEntryButton entryId={row.id} floristId={floristId} description={row.description} />
              ) : null
            }
          />
        </CardBody>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm">
            <span className="text-slate-500">
              Страница {list.page} из {totalPages}
            </span>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm" disabled={list.page <= 1}>
                <Link href={qs({ page: String(list.page - 1) })}>Назад</Link>
              </Button>
              <Button asChild variant="outline" size="sm" disabled={list.page >= totalPages}>
                <Link href={qs({ page: String(list.page + 1) })}>Вперёд</Link>
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
