import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import type { OutboxRecord, OutboxStatus } from "@/outbox/types";
import { retryOutboxEvent } from "./actions";

const statusMeta: Record<OutboxStatus, { label: string; className: string }> = {
  PENDING: { label: "Ожидает", className: "bg-slate-100 text-slate-600 border-slate-200" },
  PROCESSING: { label: "В обработке", className: "bg-blue-50 text-blue-700 border-blue-200" },
  PROCESSED: { label: "Обработано", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  FAILED: { label: "Сбой (повтор)", className: "bg-amber-100 text-amber-800 border-amber-200" },
  DEAD_LETTER: { label: "Не доставлено", className: "bg-red-50 text-red-700 border-red-200" },
};

function fmt(d: Date): string {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium" }).format(new Date(d));
}

export function SystemEventsTable({ events }: { events: OutboxRecord[] }) {
  if (events.length === 0) {
    return <EmptyState title="Событий нет" description="Здесь появятся фоновые доменные события и их статусы." />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
            <th className="px-3 py-2 font-medium">Тип события</th>
            <th className="px-3 py-2 font-medium">Статус</th>
            <th className="px-3 py-2 font-medium">Попытки</th>
            <th className="px-3 py-2 font-medium">Обновлено</th>
            <th className="px-3 py-2 font-medium">Последняя ошибка</th>
            <th className="px-3 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const m = statusMeta[e.status];
            const canRetry = e.status === "FAILED" || e.status === "DEAD_LETTER";
            return (
              <tr key={e.id} className="border-b border-slate-50 align-top">
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800">{e.eventType}</div>
                  <div className="text-[11px] text-slate-400">{e.aggregateType}:{e.aggregateId}</div>
                </td>
                <td className="px-3 py-2"><Badge className={m.className}>{m.label}</Badge></td>
                <td className="px-3 py-2 text-slate-600">{e.attempts}/{e.maxAttempts}</td>
                <td className="px-3 py-2 whitespace-nowrap text-slate-500">{fmt(e.updatedAt)}</td>
                <td className="px-3 py-2 text-slate-500">
                  {e.lastError ? <span className="line-clamp-2 max-w-xs">{e.lastError}</span> : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  {canRetry && (
                    <form action={retryOutboxEvent}>
                      <input type="hidden" name="id" value={e.id} />
                      <Button type="submit" variant="outline" size="sm">Повторить</Button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
