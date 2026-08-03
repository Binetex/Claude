"use client";
/**
 * Блок дополнительных расходов в карточке заказа. Один на владельца, колл-центр и флориста.
 *
 * Показываются только четыре колонки: дата, описание, сумма, действия. Ни исполнителя, ни
 * автора записи здесь нет намеренно — флорист определяется системой, а авторство живёт в
 * аудите. Лишняя колонка тут означала бы поле, которое пользователь захочет выбрать сам.
 *
 * Отменённые строки видны зачёркнутыми и в итог не входят: расход, по которому уже прошли
 * деньги, обязан остаться в истории.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatCents } from "@/lib/cents";

export type OrderExpenseDto = {
  id: string;
  amountCents: number;
  description: string;
  expenseDate: string;
  reversedAt: string | null;
  reversalReason: string | null;
  used: boolean;
};

export type OrderExpenseActions = {
  add: (fd: FormData) => Promise<{ error?: string; message?: string }>;
  update: (fd: FormData) => Promise<{ error?: string; message?: string }>;
  remove: (fd: FormData) => Promise<{ error?: string; message?: string }>;
};

/** Подсказки под полем описания: частые случаи, но без жёсткого списка категорий. */
const HINTS = [
  "Повторная доставка",
  "Повторное изготовление букета",
  "Дополнительные цветы",
  "Компенсация клиенту",
  "Прочее",
];

const todayKey = () => new Date().toISOString().slice(0, 10);

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function ExpenseDialog({
  actions,
  orderId,
  trigger,
  triggerVariant = "outline",
  expense,
}: {
  actions: OrderExpenseActions;
  orderId: string;
  trigger: string;
  triggerVariant?: "default" | "outline" | "ghost";
  expense?: OrderExpenseDto;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [description, setDescription] = useState(expense?.description ?? "");

  const editing = expense != null;
  const action = editing ? actions.update : actions.add;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={triggerVariant}>
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Изменить расход" : "Добавить расход"}</DialogTitle>
        </DialogHeader>
        <form
          action={(fd) =>
            start(async () => {
              const res = await action(fd);
              if (res.error) {
                toast.error(res.error);
                return;
              }
              toast.success(res.message ?? "Сохранено");
              setOpen(false);
            })
          }
          className="space-y-3"
        >
          <input type="hidden" name="orderId" value={orderId} />
          {editing && <input type="hidden" name="expenseId" value={expense.id} />}

          <Field label="Сумма">
            <Input
              name="amount"
              inputMode="decimal"
              placeholder="0.00"
              required
              defaultValue={expense ? (expense.amountCents / 100).toFixed(2) : ""}
            />
          </Field>

          <Field label="Описание">
            <Input
              name="description"
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="За что расход"
            />
          </Field>
          <div className="flex flex-wrap gap-1">
            {HINTS.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => setDescription(h)}
                className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500 hover:border-slate-300 hover:text-slate-700"
              >
                {h}
              </button>
            ))}
          </div>

          <Field label="Дата расхода">
            <Input name="expenseDate" type="date" required defaultValue={expense?.expenseDate ?? todayKey()} />
          </Field>

          {editing && expense.used && (
            <Field
              label="Причина исправления"
              hint="Расход уже в расчёте: прежняя запись будет отменена, а вместо неё создана новая."
            >
              <Textarea name="reason" rows={2} required />
            </Field>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Сохраняю…" : "Сохранить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  actions,
  orderId,
  expense,
}: {
  actions: OrderExpenseActions;
  orderId: string;
  expense: OrderExpenseDto;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700">
          Удалить
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Удалить расход</DialogTitle>
        </DialogHeader>
        <form
          action={(fd) =>
            start(async () => {
              const res = await actions.remove(fd);
              if (res.error) {
                toast.error(res.error);
                return;
              }
              toast.success(res.message ?? "Удалено");
              setOpen(false);
            })
          }
          className="space-y-3"
        >
          <input type="hidden" name="orderId" value={orderId} />
          <input type="hidden" name="expenseId" value={expense.id} />
          <p className="text-sm text-slate-600">
            {expense.description} · {formatCents(expense.amountCents)}
          </p>
          {expense.used && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Расход уже участвовал в расчёте, поэтому будет отменён, а не стёрт: строка останется видна
              зачёркнутой и в итог не войдёт. Расчёт пересчитается сразу.
            </p>
          )}
          <Field label="Причина" hint="Короткая, уходит в историю изменений.">
            <Textarea name="reason" rows={2} required />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Удаляю…" : "Удалить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OrderExpensesCard({
  orderId,
  rows,
  totalCents,
  canEdit,
  actions,
}: {
  orderId: string;
  rows: OrderExpenseDto[];
  totalCents: number;
  canEdit: boolean;
  actions: OrderExpenseActions;
}) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2">
        <CardTitle>Дополнительные расходы</CardTitle>
        {canEdit && <ExpenseDialog actions={actions} orderId={orderId} trigger="Добавить расход" />}
      </CardHeader>
      <CardBody className="p-0">
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-400">
            Расходов нет. Сюда вносят повторную доставку, переделку букета, компенсацию.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
                <th className="px-4 py-2 font-medium">Дата</th>
                <th className="px-3 py-2 font-medium">Описание</th>
                <th className="px-3 py-2 text-right font-medium">Сумма</th>
                {canEdit && <th className="px-4 py-2 text-right font-medium">Действия</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const off = r.reversedAt != null;
                return (
                  <tr key={r.id} className={`border-b border-slate-50 last:border-0 ${off ? "text-slate-400" : ""}`}>
                    <td className="px-4 py-2 tabular-nums">{r.expenseDate}</td>
                    <td className="px-3 py-2">
                      <span className={off ? "line-through" : ""}>{r.description}</span>
                      {off && (
                        <span className="ml-2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">
                          Отменено
                        </span>
                      )}
                      {off && r.reversalReason && <div className="text-xs text-slate-400">{r.reversalReason}</div>}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${off ? "line-through" : "font-medium"}`}>
                      {formatCents(r.amountCents)}
                    </td>
                    {canEdit && (
                      <td className="px-4 py-1.5 text-right whitespace-nowrap">
                        {!off && (
                          <div className="flex items-center justify-end gap-1">
                            <ExpenseDialog actions={actions} orderId={orderId} trigger="Изменить" expense={r} />
                            <RemoveDialog actions={actions} orderId={orderId} expense={r} />
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardBody>
      <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-sm">
        <span className="text-slate-500">Всего дополнительных расходов</span>
        <span className="font-semibold tabular-nums text-slate-900">{formatCents(totalCents)}</span>
      </div>
    </Card>
  );
}
