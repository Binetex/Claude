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

/**
 * Колонки строки расхода на широком экране. Ширины ЗАДАНЫ, а не выведены из содержимого:
 * каждая строка — своя сетка, и на `auto` колонки разных строк вставали бы по-разному, чего
 * в таблице не было. Описание — `minmax(0,1fr)`, иначе длинный текст снова начнёт задавать
 * ширину. До `sm` сетка не включается вовсе, и строка складывается в обычный поток.
 */
const rowCols = (canEdit: boolean) =>
  canEdit ? "@lg:grid-cols-[7rem_minmax(0,1fr)_6rem_9.5rem]" : "@lg:grid-cols-[7rem_minmax(0,1fr)_6rem]";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export function ExpenseDialog({
  actions,
  orderId,
  trigger,
  triggerVariant = "outline",
  triggerNode,
  expense,
  open: openProp,
  onOpenChange,
}: {
  actions: OrderExpenseActions;
  orderId: string;
  trigger: string;
  triggerVariant?: "default" | "outline" | "ghost";
  /** Свой триггер вместо обычной кнопки — например, квадратная иконка «Быстрых действий». */
  triggerNode?: React.ReactNode;
  expense?: OrderExpenseDto;
  /**
   * Управляемый режим: диалог открывает кто-то снаружи, своего триггера здесь нет.
   * Нужен там, где кнопка живёт отдельно от формы — например, в сетке «Быстрых действий»
   * рядом с картой и звонком.
   */
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : uncontrolledOpen;
  const setOpen = (v: boolean) => (controlled ? onOpenChange?.(v) : setUncontrolledOpen(v));
  const [pending, start] = useTransition();
  const [description, setDescription] = useState(expense?.description ?? "");

  const editing = expense != null;
  const action = editing ? actions.update : actions.add;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <DialogTrigger asChild>
          {triggerNode ?? (
            <Button size="sm" variant={triggerVariant}>
              {trigger}
            </Button>
          )}
        </DialogTrigger>
      )}
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
  calc,
  actions,
}: {
  orderId: string;
  rows: OrderExpenseDto[];
  totalCents: number;
  canEdit: boolean;
  calc: { counted: boolean; note: string | null };
  actions: OrderExpenseActions;
}) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2">
        <CardTitle>Дополнительные расходы</CardTitle>
        {canEdit && <ExpenseDialog actions={actions} orderId={orderId} trigger="Добавить расход" />}
      </CardHeader>
      {/* @container: раскладка строки зависит от ширины САМОЙ КАРТОЧКИ, а не экрана. Блок
          стоит и в широкой левой колонке владельца, и в узкой правой колонке флориста — по
          медиазапросу на 1440px обе считались бы «широкими», и в колонке на 350px колонки
          строки не поместились бы. */}
      <CardBody className="@container p-0">
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-400">
            Расходов нет. Сюда вносят повторную доставку, переделку букета, компенсацию.
          </p>
        ) : (
          /* Не таблица. У <table> ширина колонок считается по содержимому, и четыре колонки
             (дата + описание + сумма + две кнопки) давали min-content 464px — на телефоне это
             растягивало карточку и всю страницу. Тот же список на сетке: в широкой карточке
             четыре колонки как раньше, в узкой строка складывается в три этажа. */
          <ul className="divide-y divide-slate-50 text-sm">
            <li
              className={`hidden border-b border-slate-100 px-4 py-2 text-[11px] tracking-wide text-slate-400 uppercase @lg:grid ${rowCols(canEdit)} @lg:items-baseline @lg:gap-x-3`}
            >
              <span>Дата</span>
              <span>Описание</span>
              <span className="text-right">Сумма</span>
              {canEdit && <span className="text-right">Действия</span>}
            </li>
            {rows.map((r) => {
              const off = r.reversedAt != null;
              return (
                <li
                  key={r.id}
                  className={`px-4 py-2.5 @lg:grid @lg:py-2 ${rowCols(canEdit)} @lg:items-baseline @lg:gap-x-3 ${off ? "text-slate-400" : ""}`}
                >
                  <div className="text-xs text-slate-400 tabular-nums @lg:text-sm @lg:text-inherit">{r.expenseDate}</div>
                  {/* min-w-0 + break-words: длинное описание переносится, а не тянет колонку. */}
                  <div className="mt-0.5 min-w-0 break-words @lg:mt-0">
                    <span className={off ? "line-through" : ""}>{r.description}</span>
                    {off && (
                      <span className="ml-2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-slate-500">
                        Отменено
                      </span>
                    )}
                    {off && r.reversalReason && <div className="text-xs text-slate-400">{r.reversalReason}</div>}
                  </div>
                  {/* @lg:contents — в широкой карточке сумма и действия становятся ОТДЕЛЬНЫМИ
                      ячейками сетки (как колонки прежней таблицы), а в узкой остаются одной
                      строкой «сумма слева, кнопки справа». */}
                  <div className="mt-1 flex items-center justify-between gap-2 @lg:mt-0 @lg:contents">
                    <span className={`tabular-nums @lg:text-right ${off ? "line-through" : "font-medium"}`}>
                      {formatCents(r.amountCents)}
                    </span>
                    {canEdit && (
                      <span className="flex items-center justify-end gap-1">
                        {!off && (
                          <>
                            <ExpenseDialog actions={actions} orderId={orderId} trigger="Изменить" expense={r} />
                            <RemoveDialog actions={actions} orderId={orderId} expense={r} />
                          </>
                        )}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
      <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-sm">
        <span className="text-slate-500">Всего дополнительных расходов</span>
        <span className="font-semibold tabular-nums text-slate-900">{formatCents(totalCents)}</span>
      </div>
      {calc.note && (
        <div
          className={`border-t px-4 py-2 text-xs ${
            calc.counted ? "border-slate-100 text-slate-400" : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          {calc.note}
        </div>
      )}
    </Card>
  );
}
