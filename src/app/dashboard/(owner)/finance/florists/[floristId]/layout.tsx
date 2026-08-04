import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/button";
import { FloristAvatar } from "@/components/FloristAvatar";
import { floristBalance } from "@/modules/finance/balance";
import { resolveProfileAt } from "@/modules/finance/profile";
import { FinanceTabs, type FinanceTab } from "../../FinanceTabs";
import { AddPaymentDialog, AddAdjustmentDialog } from "./FinanceForms";

/**
 * Кабинет конкретного флориста глазами владельца.
 *
 * Раньше это был технический экран книги: пять показателей, история операций и фильтры по
 * типам записей. Владелец видел не то же, что флорист, и сверить их было нечем. Теперь это
 * ТОТ ЖЕ кабинет, что у самого флориста (общие EarningsView / PayoutsView / FinanceDayView),
 * плюс владельческие действия — выплата и корректировка — компактно в шапке.
 *
 * Вкладки зависят от МОДЕЛИ профиля: «Расходы на цветы» показываются только основному
 * флористу, потому что дневная закупка существует только у PRIMARY. Показывать вкладку,
 * ведущую в отказ, значит обещать раздел, которого у человека нет.
 *
 * Шапка и вкладки живут в layout, а не в каждой странице: вложенный разбор дня иначе
 * оставался бы без выхода наружу.
 */
export default async function FloristCabinetLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ floristId: string }>;
}) {
  await requireRole("OWNER");
  const { floristId } = await params;

  const florist = await prisma.florist.findUnique({
    where: { id: floristId },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!florist) notFound();

  const [balance, profile] = await Promise.all([
    floristBalance(floristId),
    // Без явной даты: «сейчас» по умолчанию, и мемоизация cache() срабатывает на все
    // три обращения к модели за один рендер кабинета.
    resolveProfileAt(floristId),
  ]);

  const base = `/dashboard/finance/florists/${floristId}`;
  const tabs: FinanceTab[] = [
    { href: base, label: "Заработок" },
    { href: `${base}/payouts`, label: "История выплат" },
    ...(profile?.model === "PRIMARY" ? [{ href: `${base}/flower-expenses`, label: "Расходы на цветы" }] : []),
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <FloristAvatar name={florist.user.name} avatarUrl={florist.avatarUrl} size={26} />
            <span className="break-words">{florist.user.name}</span>
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
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/finance/florists">К списку</Link>
            </Button>
            <AddAdjustmentDialog floristId={floristId} />
            <AddPaymentDialog floristId={floristId} outstandingCents={balance.outstandingCents} />
          </div>
        }
      />

      <FinanceTabs tabs={tabs} />
      {children}
    </div>
  );
}
