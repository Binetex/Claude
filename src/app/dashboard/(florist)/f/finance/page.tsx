import Link from "next/link";
import { requireFlorist } from "@/lib/rbac";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/cents";
import { BalanceSummary, LedgerTable } from "@/components/finance/LedgerTable";
import { listLedgerEntries } from "@/modules/finance/ledger";
import { floristBalance } from "@/modules/finance/balance";
import { resolveProfileAt } from "@/modules/finance/profile";

export const dynamic = "force-dynamic";

const PER_PAGE = 50;

/**
 * Свои финансы флориста.
 *
 * В маршруте СОЗНАТЕЛЬНО нет сегмента [floristId]: подставлять чужой id физически некуда.
 * Идентификатор берётся из сессии через requireFlorist(), и ни одна функция на этой
 * странице не принимает floristId снаружи. Колл-центр сюда не попадёт: requireFlorist
 * требует роль FLORIST и уводит остальных на их домашнюю страницу.
 */
export default async function FloristFinancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireFlorist();
  const sp = await searchParams;
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);

  const [balance, list, profile] = await Promise.all([
    floristBalance(user.floristId),
    listLedgerEntries(user.floristId, { page, perPage: PER_PAGE }),
    resolveProfileAt(user.floristId, new Date()),
  ]);

  const totalPages = Math.max(Math.ceil(list.total / PER_PAGE), 1);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Мои финансы"
        description="Начисления за доставленные заказы, бонусы, удержания и выплаты."
      />

      <Card>
        <CardBody>
          <div className="mb-4 rounded-lg bg-slate-800 px-4 py-3 text-center">
            <div className="text-xs text-slate-300">К выплате</div>
            <div className="text-3xl font-bold text-white tabular-nums">
              {formatCents(balance.outstandingCents)}
            </div>
          </div>
          <BalanceSummary {...balance} />
          {profile?.model === "PRIMARY" && (
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
              Здесь показаны только уже проведённые операции. Доля от прибыли за период
              появится отдельной строкой, когда её начнут рассчитывать.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>История · {list.total}</CardTitle>
        </CardHeader>
        <CardBody className="p-0 px-4">
          {/* actions не передаём: изменить или отменить операцию флорист не может. */}
          <LedgerTable rows={list.entries} orderHrefBase="/dashboard/f" shareDayHrefBase="/dashboard/f/finance/day" />
        </CardBody>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm">
            <span className="text-slate-500">
              Страница {list.page} из {totalPages}
            </span>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm" disabled={list.page <= 1}>
                <Link href={`/dashboard/f/finance?page=${list.page - 1}`}>Назад</Link>
              </Button>
              <Button asChild variant="outline" size="sm" disabled={list.page >= totalPages}>
                <Link href={`/dashboard/f/finance?page=${list.page + 1}`}>Вперёд</Link>
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
