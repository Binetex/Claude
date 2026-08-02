import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/states";
import { FloristAvatar } from "@/components/FloristAvatar";
import { formatCents } from "@/lib/cents";
import { getFloristBalances } from "@/modules/finance/ledger";
import { listCurrentProfiles } from "@/modules/finance/profile";
import { countDeliveredByFlorist } from "@/modules/finance/review";
import { accrualGate } from "@/modules/finance/config";

export const dynamic = "force-dynamic";

const modelMeta = {
  PRIMARY: { label: "Основной", className: "bg-violet-50 text-violet-700 border-violet-200" },
  SECONDARY: { label: "Второстепенный", className: "bg-sky-50 text-sky-700 border-sky-200" },
} as const;

export default async function FinanceFloristsPage() {
  await requireRole("OWNER");

  const florists = await prisma.florist.findMany({
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  const ids = florists.map((f) => f.id);

  const [balances, profiles, delivered] = await Promise.all([
    getFloristBalances(ids),
    listCurrentProfiles(),
    countDeliveredByFlorist(ids),
  ]);

  const gate = accrualGate();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Финансы — флористы"
        description="Начисления и выплаты. Все суммы считаются из книги операций, отдельного «сколько должны» не существует."
      />

      {!gate.enabled && (
        <Card>
          <CardBody className="text-sm text-slate-600">
            <div className="font-medium text-slate-800">Начисления выключены</div>
            <div className="mt-1 text-slate-500">
              Причина: {gate.reason}. Пока гейт закрыт, новые начисления не создаются — ни автоматически,
              ни при доставке заказа. Уже созданные записи продолжают отображаться.
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="p-0">
          {florists.length === 0 ? (
            <EmptyState title="Флористов нет" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
                    <th className="px-4 py-2.5 font-medium">Флорист</th>
                    <th className="px-3 py-2.5 font-medium">Модель</th>
                    <th className="px-3 py-2.5 text-right font-medium">Доставлено</th>
                    <th className="px-3 py-2.5 text-right font-medium">Начислено</th>
                    <th className="px-3 py-2.5 text-right font-medium">Бонусы</th>
                    <th className="px-3 py-2.5 text-right font-medium">Удержания</th>
                    <th className="px-3 py-2.5 text-right font-medium">Выплачено</th>
                    <th className="px-4 py-2.5 text-right font-medium">К выплате</th>
                  </tr>
                </thead>
                <tbody>
                  {florists.map((f) => {
                    const b = balances.get(f.id)!;
                    const profile = profiles.get(f.id);
                    return (
                      <tr key={f.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                        <td className="px-4 py-3">
                          <Link href={`/dashboard/finance/florists/${f.id}`} className="flex items-center gap-2">
                            <FloristAvatar name={f.user.name} avatarUrl={f.avatarUrl} size={24} />
                            <span className="font-medium text-slate-800 hover:underline">{f.user.name}</span>
                            {!f.active && <span className="text-xs text-slate-400">отключён</span>}
                          </Link>
                        </td>
                        <td className="px-3 py-3">
                          {profile ? (
                            <Badge className={modelMeta[profile.model].className}>{modelMeta[profile.model].label}</Badge>
                          ) : (
                            // Отсутствие профиля — не «по умолчанию второстепенный».
                            // Пока модель не задана, начисление не создаётся вовсе.
                            <Badge className="border-amber-200 bg-amber-50 text-amber-800">не задана</Badge>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-slate-600">{delivered.get(f.id) ?? 0}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{formatCents(b.accruedCents)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-slate-600">{formatCents(b.bonusCents)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-slate-600">{formatCents(b.deductionCents)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-slate-600">{formatCents(b.paidCents)}</td>
                        <td
                          className={`px-4 py-3 text-right font-semibold tabular-nums ${
                            b.outstandingCents < 0 ? "text-red-600" : "text-emerald-700"
                          }`}
                        >
                          {formatCents(b.outstandingCents)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
