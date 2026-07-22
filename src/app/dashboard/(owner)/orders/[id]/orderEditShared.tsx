"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { saveOrderBlock, type SaveOrderBlockResult } from "@/modules/orders/editActions";
import type { OrderBlock, BlockFormData } from "@/modules/orders/updateOrderBlock";

/**
 * Общая клиентская логика редактирования блока заказа с оптимистической блокировкой (OCC).
 * Используется во всех редактируемых блоках (owner/call-center/florist) — единый путь и UX.
 */

export const CONFLICT_MESSAGE = "Заказ уже изменён другим пользователем. Обновите данные и повторите сохранение.";

export type ConflictState = { current: Record<string, string>; updatedAt: string };

function errorText(res: Exclude<SaveOrderBlockResult, { status: "ok" } | { status: "conflict" }>): string {
  switch (res.status) {
    case "forbidden": return "Нет прав на редактирование этого заказа.";
    case "notfound": return "Заказ не найден.";
    case "invalid": return res.error;
  }
}

/**
 * Хук сохранения блока: держит версию записи (expectedUpdatedAt) и состояние конфликта.
 * При конфликте введённые данные НЕ сбрасываются — пользователь сам решает, обновить ли.
 */
export function useBlockSave(orderId: string, block: OrderBlock, initialUpdatedAt: string) {
  const [pending, start] = useTransition();
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(initialUpdatedAt);
  const [conflict, setConflict] = useState<ConflictState | null>(null);

  function save(data: BlockFormData, opts?: { successMessage?: string; onOk?: () => void }) {
    start(async () => {
      const res = await saveOrderBlock(orderId, block, expectedUpdatedAt, data);
      if (res.status === "ok") {
        setExpectedUpdatedAt(res.updatedAt);
        setConflict(null);
        if (opts?.successMessage) toast.success(opts.successMessage);
        opts?.onOk?.();
      } else if (res.status === "conflict") {
        setConflict({ current: res.current, updatedAt: res.updatedAt });
        toast.error(CONFLICT_MESSAGE);
      } else {
        toast.error(errorText(res));
      }
    });
  }

  /** Принять текущие значения из БД: обновляет версию и снимает конфликт; форму заполняет caller. */
  function acceptCurrentVersion(apply: (current: Record<string, string>) => void) {
    if (!conflict) return;
    apply(conflict.current);
    setExpectedUpdatedAt(conflict.updatedAt);
    setConflict(null);
  }

  return { pending, conflict, save, acceptCurrentVersion };
}

/** Плашка конфликта: показывает текущие значения в БД и кнопку «Обновить данные». */
export function ConflictNotice({
  current,
  labels,
  onRefresh,
}: {
  current: Record<string, string>;
  labels: { k: string; label: string }[];
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
      <p className="font-medium text-amber-800">{CONFLICT_MESSAGE}</p>
      <p className="text-xs text-amber-700">Заказ редактируется несколькими пользователями. Текущие значения в базе:</p>
      <ul className="space-y-0.5 text-amber-900">
        {labels.filter((l) => l.k in current).map((l) => (
          <li key={l.k}><span className="text-amber-600">{l.label}:</span> {current[l.k] || "—"}</li>
        ))}
      </ul>
      <Button type="button" size="sm" variant="outline" onClick={onRefresh}>Обновить данные</Button>
    </div>
  );
}
