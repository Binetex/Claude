import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { listSnapshotRevisions } from "@/modules/finance/snapshot";
import type { SnapshotStatus } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

const statusMeta: Record<SnapshotStatus, { label: string; className: string }> = {
  DRAFT: { label: "Черновик", className: "border-slate-200 bg-slate-50 text-slate-600" },
  PUBLISHED: { label: "Действует", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  SUPERSEDED: { label: "Вытеснена", className: "border-slate-200 bg-slate-50 text-slate-400" },
};

const missingLabels: Record<string, string> = {
  DELIVERY_ACTUAL_COST: "фактическая доставка",
  ACQUIRING_FEE: "комиссия эквайринга",
  VASE_GIFT_COST: "закупка вазы или подарка",
  CONSUMABLES_RATE: "ставка расходников",
  DAILY_FLOWER_EXPENSE: "дневная закупка цветов",
  FLOWER_REVENUE: "цветочная выручка",
};

export default async function OrderSnapshotPage({ params }: { params: Promise<{ orderId: string }> }) {
  await requireRole("OWNER");
  const { orderId } = await params;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, deliveryDate: true, site: { select: { shortName: true } } },
  });
  if (!order) notFound();

  // Показывается ТОЛЬКО действующий расчёт. Список прежних ревизий отсюда убран: он
  // объяснял историю пересчётов, а объяснять нужно историю денег — она видна в книге,
  // где у каждой записи свои цифры.
  const revisions = await listSnapshotRevisions(orderId);
  const current = revisions.find((r) => r.status === "PUBLISHED") ?? revisions[0];

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Финансовый снимок · ${order.orderNumber}`}
        description={`${order.site.shortName} · доставка ${order.deliveryDate.toISOString().slice(0, 10)}`}
        actions={
          <div className="flex items-center gap-3 text-sm">
            <Link href={`/dashboard/orders/${order.id}`} className="text-slate-500 hover:text-slate-800">
              К заказу
            </Link>
            <Link href="/dashboard/finance/setup" className="text-slate-500 hover:text-slate-800">
              Требует заполнения
            </Link>
          </div>
        }
      />

      {!current ? (
        <Card>
          <CardBody>
            <EmptyState
              title="Снимок ещё не собран"
              description="Он появится после того, как будут заполнены исходные данные дня."
            />
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>
                Ревизия {current.revision}{" "}
                <Badge className={statusMeta[current.status].className}>{statusMeta[current.status].label}</Badge>
              </CardTitle>
              <span className="text-xs text-slate-400">
                собран {current.createdAt.toISOString().slice(0, 16).replace("T", " ")}
              </span>
            </CardHeader>
            <CardBody className="space-y-4">
              {!current.isCalculable && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Заказ не участвует в расчёте. Не хватает:{" "}
                  {(readMissing(current.calcInputJson) ?? []).map((m) => missingLabels[m] ?? m).join(", ") || "—"}.
                  <div className="mt-1 text-xs">
                    Его доля дневной закупки — {formatCents(current.allocatedFlowerCents)} — зарезервирована и остаётся
                    нераспределённой, чтобы не увеличивать расходы исправных заказов.
                  </div>
                </div>
              )}

              <div>
                <div className="mb-1.5 text-[11px] font-medium tracking-wide text-slate-400 uppercase">Строки расчёта</div>
                <table className="w-full text-sm">
                  <tbody>
                    <Row label="Получено от клиента (товары + налог + доставка + чаевые)" cents={current.grossRevenueCents} />
                    <Row label="Чаевые (принадлежат владельцу)" cents={-current.tipsCents} />
                    <Row label="Полный Tax Reserve" cents={-current.taxCents} />
                    <Row label="Фактическая доставка" cents={-current.deliveryActualCents} />
                    <Row
                      label={`Комиссия эквайринга (${current.acquiringFeeSource === "ACTUAL" ? "фактическая" : "расчётная"})`}
                      cents={-current.acquiringFeeCents}
                    />
                    <Row label="Закупка ваз и подарков" cents={-current.vaseGiftCostCents} />
                    <Row label="Расходники" cents={-current.consumablesCents} />
                    <Row label="Распределённые расходы на цветы" cents={-current.allocatedFlowerCents} />
                    {current.otherExpenseCents > 0 && <Row label="Дополнительные расходы" cents={-current.otherExpenseCents} />}
                    <tr className="border-t border-slate-200">
                      <td className="py-2 font-medium text-slate-800">Распределяемая прибыль</td>
                      <td
                        className={`py-2 text-right font-semibold tabular-nums ${
                          current.distributableCents < 0 ? "text-red-600" : "text-slate-900"
                        }`}
                      >
                        {formatCents(current.distributableCents)}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div className="mt-1.5 text-xs text-slate-400">
                  Цветочная часть заказа — {formatCents(current.flowerRevenueCents)}; по ней считалась доля дневной закупки.
                </div>
              </div>

              <details>
                <summary className="cursor-pointer text-sm text-slate-500">Полный вход расчёта</summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
                  {JSON.stringify(current.calcInputJson, null, 2)}
                </pre>
                <div className="mt-1.5 text-xs text-slate-400">
                  Здесь лежат id и даты действия всех применённых настроек — расчёт объясним без обращения к текущему
                  каталогу.
                </div>
              </details>
            </CardBody>
          </Card>

        </>
      )}
    </div>
  );
}

function Row({ label, cents }: { label: string; cents: number }) {
  return (
    <tr className="border-b border-slate-50">
      <td className="py-1.5 text-slate-600">{label}</td>
      <td className={`py-1.5 text-right tabular-nums ${cents < 0 ? "text-slate-700" : "text-slate-900"}`}>
        {formatCents(cents)}
      </td>
    </tr>
  );
}

/** Причины needsReview лежат внутри входа расчёта — отдельной колонки под них нет. */
function readMissing(calcInput: unknown): string[] | null {
  if (!calcInput || typeof calcInput !== "object") return null;
  const value = (calcInput as { needsReview?: unknown }).needsReview;
  return Array.isArray(value) ? (value as string[]) : null;
}
