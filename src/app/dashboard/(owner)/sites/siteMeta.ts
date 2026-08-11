/**
 * Общие для списка магазинов и карточки магазина мелочи: подписи статусов подключения и сборка
 * снимка синхронизации. Обычный модуль (не "use client") — его импортируют серверные страницы,
 * а из клиентского модуля значение импортировать нельзя (см. CLAUDE.md про client boundary).
 */
import type { SyncKind, SiteSyncStatus } from "@/generated/prisma/enums";
import type { SyncStatusSnapshot } from "@/app/dashboard/(owner)/actions";

export const connStatusMeta: Record<string, { label: string; className: string }> = {
  CONNECTING: { label: "Проверка…", className: "bg-amber-100 text-amber-800 border-amber-200" },
  CONNECTED: { label: "Подключён", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  DEGRADED: { label: "Ограниченный доступ", className: "bg-orange-100 text-orange-800 border-orange-200" },
  REAUTH_REQUIRED: { label: "Требуется переподключение", className: "bg-red-100 text-red-800 border-red-200" },
  DISCONNECTED: { label: "Отключён", className: "bg-slate-100 text-slate-600 border-slate-200" },
};

type SyncRow = {
  kind: SyncKind;
  status: SiteSyncStatus;
  total: number | null;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  errorMessage: string | null;
  finishedAt: Date | null;
};

/** Снимок последних прогонов синхронизации в форме, которую ждут клиентские контролы. */
export function syncSnapshot(syncs: SyncRow[]): SyncStatusSnapshot {
  const pick = (kind: "PRODUCTS" | "ORDERS") => {
    const r = syncs.find((x) => x.kind === kind);
    if (!r) return null;
    return {
      status: r.status,
      total: r.total,
      processed: r.processed,
      created: r.created,
      updated: r.updated,
      skipped: r.skipped,
      errors: r.errors,
      errorMessage: r.errorMessage,
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    };
  };
  return { products: pick("PRODUCTS"), orders: pick("ORDERS") };
}

export const dateTime = (d: Date | null | undefined): string =>
  d ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(d) : "—";
