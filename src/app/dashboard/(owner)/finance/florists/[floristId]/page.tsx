import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { Card, CardBody } from "@/components/ui/Card";
import { EarningsView } from "@/components/finance/EarningsView";
import { resolveProfileAt } from "@/modules/finance/profile";
import { accrualGate } from "@/modules/finance/config";
import { SharePercentForm, RecomputeShareButton } from "./ShareControls";

export const dynamic = "force-dynamic";

/**
 * Заработок флориста глазами владельца. Ровно тот же EarningsView, что у самого флориста —
 * иначе два экрана про одни деньги неизбежно разойдутся, что уже случалось.
 *
 * Своё здесь только владельческое: доля основного флориста, ручной пересчёт и ссылка на
 * полную книгу. Раньше доля и пересчёт жили на отдельной верхнеуровневой вкладке «Доля
 * основного флориста», которая целиком повторяла этот экран, а книга была главным экраном
 * кабинета — и вместо денег человек видел таблицу операций.
 */
export default async function OwnerFloristEarningsPage({
  params,
  searchParams,
}: {
  params: Promise<{ floristId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole("OWNER");
  const { floristId } = await params;
  const profile = await resolveProfileAt(floristId);
  const gate = accrualGate();
  const base = `/dashboard/finance/florists/${floristId}`;

  return (
    <EarningsView
      floristId={floristId}
      searchParams={await searchParams}
      basePath={base}
      dayHrefBase={`${base}/day`}
      orderHrefBase="/dashboard/orders"
      extra={
        <>
          {!gate.enabled && (
            <Card>
              <CardBody className="text-sm text-slate-600">
                <div className="font-medium text-slate-800">Начисления выключены</div>
                <div className="mt-1 text-slate-500">
                  Причина: {gate.reason}. Пока гейт закрыт, заработок не считается вовсе.
                </div>
              </CardBody>
            </Card>
          )}

          {profile?.model === "PRIMARY" && (
            <Card>
              <CardBody className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800">
                    Доля от прибыли —{" "}
                    {profile.sharePercentBp != null ? `${(profile.sharePercentBp / 100).toFixed(2)}%` : "не задана"}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {profile.sharePercentBp != null
                      ? "Дни считаются целиком. Пересчёт нужен, только если ждать очередного прохода не хочется."
                      : "Пока процент не задан, заработок не считается: подставлять значение «по умолчанию» нельзя — это деньги."}
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <SharePercentForm
                    floristId={floristId}
                    defaultDate={gate.enabled ? gate.startDate : null}
                    compact={profile.sharePercentBp != null}
                  />
                  {profile.sharePercentBp != null && <RecomputeShareButton />}
                </div>
              </CardBody>
            </Card>
          )}

          {/* Книга — не главный экран, а справка: ссылкой, а не таблицей во весь экран. */}
          <Link href={`${base}/ledger`} className="inline-flex text-sm text-slate-500 hover:text-slate-900">
            Все операции по книге →
          </Link>
        </>
      }
    />
  );
}
