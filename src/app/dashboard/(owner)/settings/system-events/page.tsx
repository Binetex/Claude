import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { Card, CardBody } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/states";
import { SystemEventsTable } from "./SystemEventsTable";
import type { OutboxRecord, OutboxStatus } from "@/outbox/types";

export const dynamic = "force-dynamic";

const countMeta: { key: OutboxStatus; label: string; className: string }[] = [
  { key: "PENDING", label: "Ожидают", className: "text-slate-600" },
  { key: "PROCESSING", label: "В обработке", className: "text-blue-700" },
  { key: "PROCESSED", label: "Обработано", className: "text-emerald-700" },
  { key: "FAILED", label: "Сбой", className: "text-amber-700" },
  { key: "DEAD_LETTER", label: "Не доставлено", className: "text-red-700" },
];

export default async function SystemEventsPage() {
  await requireRole("OWNER");

  const repo = new PrismaOutboxRepository(prisma);
  let events: OutboxRecord[] = [];
  let counts: Record<OutboxStatus, number> | null = null;
  let notReady = false;
  try {
    [events, counts] = await Promise.all([repo.list({ limit: 100 }), repo.countByStatus()]);
  } catch {
    // Таблица outbox ещё не создана (миграция не применена) или БД недоступна — не падаем.
    notReady = true;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Системные события</h1>
        <p className="text-sm text-slate-500">Фоновые доменные события и их доставка. Только для владельца.</p>
      </div>

      {notReady ? (
        <ErrorState
          title="Таблица событий ещё не создана"
          description="Примените миграцию 20260718040000_outbox_events (см. docs/OUTBOX_AND_WORKER.md), затем запустите floremart-worker."
        />
      ) : (
        <>
          {counts && (
            <Card>
              <CardBody>
                <div className="flex flex-wrap gap-6">
                  {countMeta.map((c) => (
                    <div key={c.key}>
                      <div className={`text-xl font-semibold ${c.className}`}>{counts[c.key]}</div>
                      <div className="text-xs text-slate-400">{c.label}</div>
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          )}
          <Card>
            <CardBody>
              <SystemEventsTable events={events} />
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
