"use client";
import { useState } from "react";
import { MapPin, UserRoundPlus, Receipt } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { ExpenseDialog } from "@/components/finance/OrderExpensesCard";
import type { OrderExpenseActions } from "@/components/finance/OrderExpensesCard";
import { FloristHandoff } from "../FloristHandoff";

/**
 * Быстрые действия флориста одной компактной карточкой.
 *
 * Каждое действие — квадрат с иконкой и подписью: подпись обязательна, иконка сама по себе
 * читается по-разному разными людьми. Значение дублируется в aria-label и тултипе, поэтому
 * действие понятно и с клавиатуры, и скринридером.
 *
 * Передача заказа и добавление расхода открывают СУЩЕСТВУЮЩИЕ формы (FloristHandoff и
 * ExpenseDialog) — второй реализации того же сценария на странице нет.
 */
/**
 * Плитка действия. Иконка сидит в собственной подложке — так у ряда есть ритм, а состояние
 * читается по подложке, а не по рамке. Плитка никуда не смещается при наведении: страница
 * рабочая, а дрожание элементов под курсором на ней только мешает.
 */
const tile =
  "group flex h-[68px] w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-1 text-center text-[11px] leading-tight font-medium text-slate-600 shadow-xs transition-colors hover:border-slate-300 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/60 disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40";

const tileIcon =
  "flex size-7 items-center justify-center rounded-md bg-slate-100 text-slate-500 transition-colors group-hover:bg-slate-900 group-hover:text-white";

export function FloristQuickActions({
  orderId,
  mapsUrl,
  handoffTargets,
  expenseActions,
}: {
  orderId: string;
  mapsUrl: string;
  handoffTargets: { id: string; name: string }[];
  expenseActions: OrderExpenseActions;
}) {
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="py-2.5"><CardTitle>Быстрые действия</CardTitle></CardHeader>
      <CardBody className="grid grid-cols-3 gap-2 py-3">
        {/* Кнопки завёрнуты в span: Tooltip клонирует ребёнка через Slot, а у отключённого
            элемента (нет телефона, некому передать) событий мыши нет вовсе — подсказка тогда
            не показалась бы именно там, где нужнее всего объяснить, почему кнопка неактивна. */}
        <Tooltip content="Открыть адрес получателя на карте">
          <span>
            <a href={mapsUrl} target="_blank" rel="noreferrer" aria-label="Открыть адрес на карте" className={tile}>
              <span className={tileIcon}><MapPin aria-hidden className="size-4" /></span>
              Карта
            </a>
          </span>
        </Tooltip>

        <Tooltip content={handoffTargets.length ? "Передать заказ другому флористу" : "Нет других активных флористов"}>
          <span>
            <button
              type="button"
              aria-label="Передать заказ другому флористу"
              disabled={handoffTargets.length === 0}
              onClick={() => setHandoffOpen(true)}
              className={tile}
            >
              <span className={tileIcon}><UserRoundPlus aria-hidden className="size-4" /></span>
              Передать
            </button>
          </span>
        </Tooltip>

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
      </CardBody>

      {/* Форма расхода — существующая. Открывается управляемо: триггер стоит в сетке выше
          рядом с остальными действиями, а сам диалог рендерится здесь. */}
      <ExpenseDialog
        actions={expenseActions}
        orderId={orderId}
        trigger="Расходы"
        open={expenseOpen}
        onOpenChange={setExpenseOpen}
      />

      <Dialog open={handoffOpen} onOpenChange={setHandoffOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Передать заказ</DialogTitle>
          </DialogHeader>
          <FloristHandoff orderId={orderId} florists={handoffTargets} embedded onDone={() => setHandoffOpen(false)} />
        </DialogContent>
      </Dialog>
    </Card>
  );
}
