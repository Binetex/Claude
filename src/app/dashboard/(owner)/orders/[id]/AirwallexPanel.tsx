import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";

/**
 * Состояние сверки платежа с Airwallex. Только для владельца — флористам и колл-центру этот
 * блок не отдаётся (нет в их сериализации). Режим наблюдения: тут только факты Airwallex,
 * business status заказа мониторинг не меняет.
 */
export type AirwallexView = {
  paymentMethod: string | null;
  intentIdShort: string | null;
  rawStatus: string | null;
  normalizedStatus: string | null;
  attemptStatus: string | null;
  lastCheckedAt: Date | string | null;
  nextCheckAt: Date | string | null;
  pendingSinceMinutes: number | null;
  monitoringActive: boolean;
  safeError: string | null;
};

const TONE: Record<string, string> = {
  PAID: "bg-emerald-100 text-emerald-800 border-emerald-200",
  AUTHORIZED_NOT_CAPTURED: "bg-teal-100 text-teal-800 border-teal-200",
  PENDING: "bg-amber-100 text-amber-800 border-amber-200",
  ACTION_REQUIRED: "bg-sky-100 text-sky-800 border-sky-200",
  NOT_STARTED: "bg-slate-100 text-slate-700 border-slate-200",
  FAILED: "bg-red-100 text-red-800 border-red-200",
  CANCELLED: "bg-slate-200 text-slate-700 border-slate-300",
  NOT_FOUND: "bg-orange-100 text-orange-800 border-orange-200",
  UNKNOWN: "bg-slate-100 text-slate-600 border-slate-200",
};

const LABEL: Record<string, string> = {
  PAID: "Оплачено",
  AUTHORIZED_NOT_CAPTURED: "Авторизовано, не списано",
  PENDING: "В обработке",
  ACTION_REQUIRED: "Нужно действие клиента",
  NOT_STARTED: "Оплата не начата",
  FAILED: "Платёж не прошёл",
  CANCELLED: "Отменён",
  NOT_FOUND: "Платёж не найден",
  UNKNOWN: "Неизвестный статус",
};

const fmt = (d: Date | string | null) => (d ? new Date(d).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—");

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <span className="text-slate-400">{label}</span>
      <span className="text-right text-slate-700">{value}</span>
    </div>
  );
}

export function AirwallexPanel({ aw }: { aw: AirwallexView }) {
  const norm = aw.normalizedStatus ?? "UNKNOWN";
  return (
    <Card>
      <CardHeader><CardTitle>Airwallex</CardTitle></CardHeader>
      <CardBody className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded border px-1.5 py-px text-[11px] font-medium ${TONE[norm] ?? TONE.UNKNOWN}`}>
            {LABEL[norm] ?? norm}
          </span>
          {!aw.monitoringActive && (
            <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] text-slate-500">сверка завершена</span>
          )}
        </div>

        <Row label="Способ оплаты" value={aw.paymentMethod ?? "—"} />
        <Row label="Payment intent" value={<code className="rounded bg-slate-100 px-1 font-mono">{aw.intentIdShort ?? "—"}</code>} />
        <Row label="Статус Airwallex" value={aw.rawStatus ?? "—"} />
        <Row label="Последняя попытка" value={aw.attemptStatus ?? "—"} />
        <Row label="В ожидании" value={aw.pendingSinceMinutes != null ? `${aw.pendingSinceMinutes} мин` : "—"} />
        <Row label="Проверено" value={fmt(aw.lastCheckedAt)} />
        <Row label="Следующая проверка" value={aw.monitoringActive ? fmt(aw.nextCheckAt) : "—"} />

        {aw.safeError && <p className="rounded-md bg-amber-50 p-2 text-[11px] text-amber-800">{aw.safeError}</p>}
        <p className="text-[11px] text-slate-400">
          Мониторинг только читает статус в Airwallex. Статус заказа, назначение флориста и рассылки он не меняет.
        </p>
      </CardBody>
    </Card>
  );
}
