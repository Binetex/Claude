import Link from "next/link";
import { format } from "date-fns";
import { requireRole } from "@/lib/rbac";
import { getFunnelCounts, listRecentRequests } from "@/modules/reviews/funnel";
import { REVIEW_STATUS_LABELS } from "@/lib/reviewStatus";

export const dynamic = "force-dynamic";

/**
 * Воронка запросов у владельца: где сейчас работа и где она стоит.
 *
 * Экран для наблюдения, а не для работы: вести запросы — дело колл-центра, и вторая пара
 * кнопок здесь только развела бы правду по двум экранам.
 */
export default async function ReviewRequestsPage() {
  await requireRole("OWNER");
  const [funnel, recent] = await Promise.all([getFunnelCounts(), listRecentRequests()]);

  const inWork = funnel.NEW + funnel.CALLING + funnel.LINK_SENT + funnel.PROMISED + funnel.FORGOT + funnel.READY_TO_CHECK;
  const lost = funnel.DECLINED + funnel.GAVE_UP;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Запросы отзывов</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Каждый заказ, помеченный «Попросить отзыв». Ведёт их колл-центр — здесь видно, где работа стоит.
        </p>
      </div>

      {funnel.total === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
          Запросов пока нет. Пометьте заказ «Попросить отзыв» в его карточке.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile n={inWork} label="в работе" />
            {/* Просрочка — единственное, что здесь требует действия владельца. */}
            <Tile n={funnel.overdue} label="просрочено" tone={funnel.overdue > 0 ? "warn" : undefined} />
            <Tile n={funnel.CONFIRMED} label="отзыв получен" tone="good" />
            <Tile n={lost} label="не получилось" />
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-4 py-2 font-medium">Заказ</th>
                  <th className="px-4 py-2 font-medium">Клиент</th>
                  <th className="px-4 py-2 font-medium">Точка</th>
                  <th className="px-4 py-2 font-medium">Шаг</th>
                  <th className="px-4 py-2 font-medium">Срок</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-b-0">
                    <td className="px-4 py-2">
                      <Link href={`/dashboard/orders/${r.order.id}`} className="font-mono text-xs text-sky-700 hover:underline">
                        {r.order.orderNumber}
                      </Link>
                      <span className="ml-2 text-xs text-slate-400">{r.order.site.name}</span>
                    </td>
                    <td className="px-4 py-2 text-slate-700">{r.order.senderName ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-600">{r.location?.name ?? "—"}</td>
                    <td className="px-4 py-2">
                      <span className="rounded bg-slate-100 px-1.5 py-px text-xs text-slate-700">
                        {REVIEW_STATUS_LABELS[r.status]}
                      </span>
                      {/* Подтверждённое по слову клиента не должно выглядеть так же
                          достоверно, как найденное в Google. */}
                      {r.confirmedVia === "MANUAL" && (
                        <span className="ml-1.5 text-xs text-slate-400">со слов клиента</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {r.nextActionAt ? format(r.nextActionAt, "dd.MM") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone?: "warn" | "good" }) {
  const cls =
    tone === "warn"
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : tone === "good"
        ? "border-emerald-200 bg-emerald-50 text-emerald-900"
        : "border-slate-200 bg-white text-slate-900";
  return (
    <div className={`rounded-xl border px-4 py-3 ${cls}`}>
      <div className="text-2xl font-semibold tabular-nums">{n}</div>
      <div className="text-xs opacity-70">{label}</div>
    </div>
  );
}
