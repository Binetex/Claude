import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/button";
import { FloristAvatar } from "@/components/FloristAvatar";
import { BalanceSummary, LedgerTable } from "@/components/finance/LedgerTable";
import { getFloristBalance, listLedgerEntries } from "@/modules/finance/ledger";
import { resolveProfileAt } from "@/modules/finance/profile";
import { AddPaymentDialog, AddAdjustmentDialog, ReverseEntryButton } from "./FinanceForms";
import { LedgerFilters, REVERSIBLE_TYPES } from "./LedgerFilters";
import type { LedgerEntryType } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

const PER_PAGE = 50;

/** Дата фильтра из URL. Мусор игнорируем молча — фильтр не повод для ошибки страницы. */
function parseDate(v: string | undefined): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function FloristFinancePage({
  params,
  searchParams,
}: {
  params: Promise<{ floristId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole("OWNER");
  const { floristId } = await params;
  const sp = await searchParams;

  const florist = await prisma.florist.findUnique({
    where: { id: floristId },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!florist) notFound();

  const from = parseDate(sp.from);
  const to = parseDate(sp.to);
  const types = sp.type ? ([sp.type] as LedgerEntryType[]) : undefined;
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);

  const [balance, list, profile] = await Promise.all([
    // Баланс — за ВСЁ время, а не за выбранный период: «к выплате» не бывает
    // за март. Фильтр периода влияет только на список операций ниже.
    getFloristBalance(floristId),
    listLedgerEntries(floristId, { from, to, types, page, perPage: PER_PAGE }),
    resolveProfileAt(floristId, new Date()),
  ]);

  const totalPages = Math.max(Math.ceil(list.total / PER_PAGE), 1);
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ from: sp.from, to: sp.to, type: sp.type, page: sp.page, ...patch })) {
      if (v) p.set(k, v);
    }
    const s = p.toString();
    return `/dashboard/finance/florists/${floristId}${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <FloristAvatar name={florist.user.name} avatarUrl={florist.avatarUrl} size={26} />
            {florist.user.name}
            {profile ? (
              <Badge className="border-slate-200 bg-slate-50 text-slate-600">
                {profile.model === "PRIMARY" ? "Основной" : "Второстепенный"}
              </Badge>
            ) : (
              <Badge className="border-amber-200 bg-amber-50 text-amber-800">модель не задана</Badge>
            )}
          </span>
        }
        description={florist.user.email}
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/finance/florists">К списку</Link>
            </Button>
            <AddAdjustmentDialog floristId={floristId} />
            <AddPaymentDialog floristId={floristId} outstandingCents={balance.outstandingCents} />
          </div>
        }
      />

      <Card>
        <CardBody>
          <BalanceSummary {...balance} />
          {profile?.model === "PRIMARY" && (
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
              Основной флорист получает долю от прибыли за период. Расчёт доли — следующий этап,
              поэтому здесь показаны только реально созданные операции, а не ожидаемая сумма.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>История операций · {list.total}</CardTitle>
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
