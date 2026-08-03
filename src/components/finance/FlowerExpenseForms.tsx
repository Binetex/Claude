"use client";
/**
 * Формы дневного расхода на цветы: добавление, исправление, удаление.
 *
 * Один компонент на владельца и на флориста. Различаются они не разметкой, а тем, какие
 * server actions переданы пропсами: каждая сторона проверяет свою роль у себя, а форма
 * ничего о правах не знает и знать не должна. Профиль в формах не фигурирует вовсе —
 * его резолвит сервер по сессии.
 *
 * Ключевое в UX: правку суммы нельзя подтвердить, не увидев последствий. Предпросмотр
 * запрашивается у сервера тем же расчётом, который потом применится, поэтому «станет»
 * в диалоге — это не оценка, а то самое число.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatCents } from "@/lib/cents";

export type ExpensePreviewDto = {
  day: string;
  fromCents: number | null;
  toCents: number | null;
  expenseDeltaCents: number;
  shareBeforeCents: number | null;
  shareAfterCents: number | null;
  shareDeltaCents: number;
  accruedCents: number | null;
  ordersAffected: number;
  alreadyUsed: boolean;
  warnings: string[];
};

export type ExpenseActions = {
  save: (fd: FormData) => Promise<{ error?: string; message?: string }>;
  remove: (fd: FormData) => Promise<{ error?: string; message?: string }>;
  preview: (day: string, amount: string | null) => Promise<{ error?: string; preview?: ExpensePreviewDto }>;
};

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

function PreviewPanel({ p }: { p: ExpensePreviewDto }) {
  const money = (c: number | null) => (c == null ? "—" : formatCents(c));
  const delta = (c: number) => `${c > 0 ? "+" : c < 0 ? "−" : ""}${formatCents(Math.abs(c))}`;

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="text-slate-400">Показатель</div>
        <div className="text-right text-slate-400">Было</div>
        <div className="text-right text-slate-400">Станет</div>

        <div className="text-slate-600">Расход на цветы</div>
        <div className="text-right tabular-nums">{money(p.fromCents)}</div>
        <div className="text-right font-medium tabular-nums">{p.toCents == null ? "удаляется" : formatCents(p.toCents)}</div>

        <div className="text-slate-600">Доля флориста</div>
        <div className="text-right tabular-nums">{money(p.shareBeforeCents)}</div>
        <div className="text-right font-medium tabular-nums">{money(p.shareAfterCents)}</div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-200 pt-2 text-xs text-slate-600">
        <span>
          разница в расходах: <span className="font-medium tabular-nums">{delta(p.expenseDeltaCents)}</span>
        </span>
        <span>
          разница в доле: <span className="font-medium tabular-nums">{delta(p.shareDeltaCents)}</span>
        </span>
        <span>затронуто заказов: {p.ordersAffected}</span>
      </div>
      {p.warnings.map((w) => (
        <div key={w} className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          {w}
        </div>
      ))}
    </div>
  );
}

/**
 * Диалог ввода и исправления суммы.
 *
 * Кнопка сохранения появляется только после предпросмотра, если день уже участвует в
 * опубликованном расчёте: там за подтверждением стоит изменение чужого баланса, и
 * «сохранить не глядя» быть не должно.
 */
export function ExpenseDialog({
  actions,
  trigger,
  day,
  amountCents,
  comment,
  variant = "outline",
  size = "sm",
  className,
}: {
  actions: ExpenseActions;
  trigger: string;
  day?: string;
  amountCents?: number | null;
  comment?: string | null;
  variant?: "default" | "outline" | "ghost";
  size?: "sm" | "default";
  /** Класс кнопки-триггера — например, растянуть её по ширине карточки на телефоне. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<ExpensePreviewDto | null>(null);
  const [dayValue, setDayValue] = useState(day ?? todayKey());
  const [amountValue, setAmountValue] = useState(amountCents != null ? (amountCents / 100).toFixed(2) : "");

  const reset = () => {
    setPreview(null);
    setDayValue(day ?? todayKey());
    setAmountValue(amountCents != null ? (amountCents / 100).toFixed(2) : "");
  };

  const askPreview = () =>
    start(async () => {
      const r = await actions.preview(dayValue, amountValue);
      if (r.error) {
        toast.error(r.error);
        return;
      }
      setPreview(r.preview ?? null);
    });

  const blockedUntilPreview = preview?.alreadyUsed === true && preview.shareDeltaCents !== 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size={size} variant={variant} className={className}>
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Расход на цветы за день</DialogTitle>
        </DialogHeader>
        <form
          action={(fd) =>
            start(async () => {
              const res = await actions.save(fd);
              if (res.error) {
                toast.error(res.error);
                return;
              }
              toast.success(res.message ?? "Сохранено");
              setOpen(false);
              reset();
            })
          }
          className="space-y-3"
        >
          <Field label="День" hint="Можно вносить за прошедшую и за будущую дату.">
            <Input
              name="day"
              type="date"
              required
              value={dayValue}
              onChange={(e) => {
                setDayValue(e.target.value);
                setPreview(null);
              }}
              readOnly={day != null}
            />
          </Field>
          <Field label="Сумма закупки">
            <Input
              name="amount"
              inputMode="decimal"
              required
              placeholder="0.00"
              value={amountValue}
              onChange={(e) => {
                setAmountValue(e.target.value);
                setPreview(null);
              }}
            />
          </Field>
          <Field label="Комментарий" hint="Попадает в историю изменений.">
            <Textarea name="comment" rows={2} defaultValue={comment ?? ""} />
          </Field>

          {preview && <PreviewPanel p={preview} />}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button type="button" variant="outline" disabled={pending || !dayValue || !amountValue} onClick={askPreview}>
              {pending ? "Считаю…" : "Показать, что изменится"}
            </Button>
            <Button type="submit" disabled={pending || (blockedUntilPreview && preview == null)}>
              {pending ? "Сохраняю…" : "Сохранить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Удаление ошибочной записи. Причина обязательна — она уходит в аудит. */
export function DeleteExpenseDialog({ actions, day }: { actions: ExpenseActions; day: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<ExpensePreviewDto | null>(null);

  const load = () =>
    start(async () => {
      const r = await actions.preview(day, null);
      if (r.error) {
        toast.error(r.error);
        return;
      }
      setPreview(r.preview ?? null);
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) load();
        else setPreview(null);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700">
          Удалить
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Удалить расход за {day}</DialogTitle>
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
          <input type="hidden" name="day" value={day} />
          {preview ? <PreviewPanel p={preview} /> : <p className="text-sm text-slate-400">Считаю последствия…</p>}
          <Field label="Причина удаления" hint="Обязательна: запись останется в истории изменений.">
            <Textarea name="reason" rows={2} required />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" variant="default" disabled={pending || preview == null}>
              {pending ? "Удаляю…" : "Удалить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
