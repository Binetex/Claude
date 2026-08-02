/**
 * История изменений дневного расхода — проекция FinanceAudit.
 *
 * Записи аудита переживают саму строку: удалённый расход остаётся объяснённым, иначе
 * «почему у неё изменился баланс» через месяц было бы не восстановить.
 */
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import type { Role } from "@/generated/prisma/enums";

export type ExpenseHistoryRow = {
  id: string;
  action: string;
  beforeJson: unknown;
  afterJson: unknown;
  reason: string | null;
  userName: string | null;
  role: Role;
  createdAt: Date;
};

const actionMeta: Record<string, { label: string; className: string }> = {
  SET_DAILY_FLOWER_EXPENSE: { label: "Внесён", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  UPDATE_DAILY_FLOWER_EXPENSE: { label: "Исправлен", className: "border-blue-200 bg-blue-50 text-blue-700" },
  DELETE_DAILY_FLOWER_EXPENSE: { label: "Удалён", className: "border-red-200 bg-red-50 text-red-700" },
};

const roleLabel: Record<Role, string> = { OWNER: "владелец", FLORIST: "флорист", CALL_CENTER: "колл-центр" };

function amountOf(json: unknown): number | null {
  if (!json || typeof json !== "object") return null;
  const v = (json as { amountCents?: unknown }).amountCents;
  return typeof v === "number" ? v : null;
}

export function ExpenseHistory({ rows }: { rows: ExpenseHistoryRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="py-4">
        <EmptyState title="Изменений не было" />
      </div>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
          <th className="py-2 pr-3 font-medium">Когда</th>
          <th className="py-2 pr-3 font-medium">Что</th>
          <th className="py-2 pr-3 text-right font-medium">Было</th>
          <th className="py-2 pr-3 text-right font-medium">Стало</th>
          <th className="py-2 pr-3 font-medium">Кто</th>
          <th className="py-2 font-medium">Причина</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const meta = actionMeta[r.action] ?? { label: r.action, className: "border-slate-200 bg-slate-50 text-slate-600" };
          const before = amountOf(r.beforeJson);
          const after = r.action === "DELETE_DAILY_FLOWER_EXPENSE" ? null : amountOf(r.afterJson);
          return (
            <tr key={r.id} className="border-b border-slate-50 last:border-0">
              <td className="py-2 pr-3 whitespace-nowrap text-slate-500 tabular-nums">
                {r.createdAt.toISOString().slice(0, 16).replace("T", " ")}
              </td>
              <td className="py-2 pr-3">
                <Badge className={meta.className}>{meta.label}</Badge>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                {before != null ? formatCents(before) : "—"}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-800">
                {after != null ? formatCents(after) : r.action === "DELETE_DAILY_FLOWER_EXPENSE" ? "удалён" : "—"}
              </td>
              <td className="py-2 pr-3 text-slate-600">
                {r.userName ?? "—"} <span className="text-xs text-slate-400">({roleLabel[r.role]})</span>
              </td>
              <td className="py-2 text-slate-500">{r.reason ?? ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
