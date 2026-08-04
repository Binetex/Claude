"use client";
import { useState } from "react";
import { MapPin, Receipt, UserRoundPlus, Repeat2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { ExpenseDialog, type OrderExpenseActions } from "@/components/finance/OrderExpensesCard";
import { FloristHandoff } from "@/app/dashboard/(florist)/f/FloristHandoff";
import { OwnerReassignForm } from "@/app/dashboard/(owner)/orders/[id]/OwnerReassignForm";

/**
 * Быстрые действия карточки заказа — один блок на все три роли.
 *
 * Каждое действие — квадрат с иконкой и подписью: подпись обязательна, иконка сама по себе
 * читается по-разному разными людьми. Значение дублируется в aria-label и тултипе, поэтому
 * действие понятно и с клавиатуры, и скринридером. Плитка никуда не смещается при наведении:
 * страница рабочая, и дрожание элементов под курсором на ней только мешает.
 *
 * Роль НЕ передаётся: передаётся НАБОР ДОСТУПНЫХ ДЕЙСТВИЙ. Не передали передачу заказа —
 * плитки нет; правило «кому что можно» живёт на странице и в server actions, а не здесь.
 * Все действия открывают СУЩЕСТВУЮЩИЕ формы — второй реализации сценария не заводится.
 */
const tile =
  "group flex h-[68px] w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-1 text-center text-[11px] leading-tight font-medium text-slate-600 shadow-xs transition-colors hover:border-slate-300 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/60 disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40";

const tileIcon =
  "flex size-7 items-center justify-center rounded-md bg-slate-100 text-slate-500 transition-colors group-hover:bg-slate-900 group-hover:text-white";

/** Колонки по числу плиток: на 320px четыре в ряд дают по 60px — читать нечего. */
const COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3" };

export type OrderQuickActionsProps = {
  orderId: string;
  /** Адрес получателя на карте — доступен всем ролям. */
  mapsUrl: string;
  /** Добавление дополнительного расхода. */
  expense?: { actions: OrderExpenseActions };
  /** Передача заказа другому флористу (кабинет флориста). */
  handoff?: { targets: { id: string; name: string }[] };
  /** Переназначение флориста (владелец). */
  reassign?: {
    florists: { id: string; name: string }[];
    currentFloristId: string | null;
    priceMode: "AUTO" | "MANUAL";
  };
};

export function OrderQuickActions({ orderId, mapsUrl, expense, handoff, reassign }: OrderQuickActionsProps) {
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);

  const count = 1 + (handoff || reassign ? 1 : 0) + (expense ? 1 : 0);

  return (
    <Card>
      <CardHeader className="py-2.5"><CardTitle>Быстрые действия</CardTitle></CardHeader>
      <CardBody className={`grid gap-2 py-3 ${COLS[count] ?? "grid-cols-3"}`}>
        {/* Кнопки завёрнуты в span: Tooltip клонирует ребёнка через Slot, а у отключённого
            элемента (некому передать) событий мыши нет вовсе — подсказка тогда не показалась
            бы именно там, где нужнее всего объяснить, почему кнопка неактивна. */}
        <Tooltip content="Открыть адрес получателя на карте">
          <span>
            <a href={mapsUrl} target="_blank" rel="noreferrer" aria-label="Открыть адрес на карте" className={tile}>
              <span className={tileIcon}><MapPin aria-hidden className="size-4" /></span>
              Карта
            </a>
          </span>
        </Tooltip>

        {handoff && (
          <Tooltip content={handoff.targets.length ? "Передать заказ другому флористу" : "Нет других активных флористов"}>
            <span>
              <button
                type="button"
                aria-label="Передать заказ другому флористу"
                disabled={handoff.targets.length === 0}
                onClick={() => setHandoffOpen(true)}
                className={tile}
              >
                <span className={tileIcon}><UserRoundPlus aria-hidden className="size-4" /></span>
                Передать
              </button>
            </span>
          </Tooltip>
        )}

        {reassign && (
          <Tooltip content="Назначить заказ другому флористу">
            <span>
              <button
                type="button"
                aria-label="Переназначить флориста"
                onClick={() => setReassignOpen(true)}
                className={tile}
              >
                <span className={tileIcon}><Repeat2 aria-hidden className="size-4" /></span>
                Флорист
              </button>
            </span>
          </Tooltip>
        )}

        {expense && (
          <Tooltip content="Добавить расход по заказу">
            <span>
              <button
                type="button"
                aria-label="Добавить расход по заказу"
                onClick={() => setExpenseOpen(true)}
                className={tile}
              >
                <span className={tileIcon}><Receipt aria-hidden className="size-4" /></span>
                Расходы
              </button>
            </span>
          </Tooltip>
        )}
      </CardBody>

      {/* Формы существующие. Открываются управляемо: триггеры стоят в сетке выше. */}
      {expense && (
        <ExpenseDialog
          actions={expense.actions}
          orderId={orderId}
          trigger="Расходы"
          open={expenseOpen}
          onOpenChange={setExpenseOpen}
        />
      )}

      {handoff && (
        <Dialog open={handoffOpen} onOpenChange={setHandoffOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Передать заказ</DialogTitle></DialogHeader>
            <FloristHandoff orderId={orderId} florists={handoff.targets} onDone={() => setHandoffOpen(false)} />
          </DialogContent>
        </Dialog>
      )}

      {reassign && (
        <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Переназначить флориста</DialogTitle></DialogHeader>
            <OwnerReassignForm
              orderId={orderId}
              florists={reassign.florists}
              currentFloristId={reassign.currentFloristId}
              priceMode={reassign.priceMode}
              onDone={() => setReassignOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
