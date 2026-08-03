"use client";
/**
 * Действия над записью настройки расчёта: исправить и удалить.
 *
 * Здесь сознательно НЕТ создания новой ставки. Это разные операции, и в интерфейсе они
 * разведены так же, как в коде: новая ставка — кнопка в шапке карточки, она закрывает
 * период и прошлое не трогает; исправление — действие у конкретной строки, оно
 * переписывает уже посчитанное и может двинуть баланс флориста.
 *
 * Подтвердить исправление, не увидев последствий, нельзя: кнопка сохранения включается
 * только после предпросмотра. Он считается тем же движком, что и настоящая публикация,
 * поэтому «станет» в диалоге — это то самое число, а не оценка.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatCents } from "@/lib/cents";

export type SettingEntityDto = "CONSUMABLES_RATE" | "FEE_MODEL" | "TAX_POLICY";

export type SettingPreviewDto = {
  entity: SettingEntityDto;
  op: "CORRECT" | "DELETE";
  affectedDays: number;
  affectedOrders: number;
  shareBeforeCents: number;
  shareAfterCents: number;
  shareDeltaCents: number;
  daysChanged: number;
  days: Array<{
    day: string;
    ordersTotal: number;
    ordersChanged: number;
    orderNumbers: string[];
    shareBeforeCents: number | null;
    shareAfterCents: number | null;
    accruedCents: number | null;
  }>;
  warnings: string[];
};

export type SettingActions = {
  correct: (fd: FormData) => Promise<{ error?: string; message?: string }>;
  remove: (fd: FormData) => Promise<{ error?: string; message?: string }>;
  preview: (input: {
    entity: SettingEntityDto;
    id: string;
    op: "CORRECT" | "DELETE";
    amount?: string;
    percent?: string;
    fixed?: string;
    share?: string;
    effectiveFrom?: string;
  }) => Promise<{ error?: string; preview?: SettingPreviewDto }>;
};

export type SettingRowDto = {
  id: string;
  entity: SettingEntityDto;
  effectiveFrom: string;
  amountCents?: number;
  percentBp?: number;
  fixedCents?: number;
  actualShareBp?: number;
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function PreviewPanel({ p }: { p: SettingPreviewDto }) {
  const delta = (c: number) => `${c > 0 ? "+" : c < 0 ? "−" : ""}${formatCents(Math.abs(c))}`;

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span className="text-slate-500">Затронуто дней</span>
        <span className="text-right tabular-nums">{p.affectedDays}</span>
        <span className="text-slate-500">Затронуто заказов</span>
        <span className="text-right tabular-nums">{p.affectedOrders}</span>
        <span className="text-slate-500">Доля флориста</span>
        <span className="text-right tabular-nums">
          {formatCents(p.shareBeforeCents)} → <span className="font-medium">{formatCents(p.shareAfterCents)}</span>
        </span>
        <span className="text-slate-500">Разница в доле</span>
        <span className={`text-right font-medium tabular-nums ${p.shareDeltaCents !== 0 ? "text-amber-700" : ""}`}>
          {delta(p.shareDeltaCents)}
        </span>
        <span className="text-slate-500">Дней с изменением заработка</span>
        <span className={`text-right tabular-nums ${p.daysChanged > 0 ? "font-medium text-amber-700" : ""}`}>
          {p.daysChanged}
        </span>
      </div>

      {p.days.length > 0 && (
        <details className="border-t border-slate-200 pt-2">
          <summary className="cursor-pointer text-xs text-slate-500">Разбор по дням</summary>
          <table className="mt-1.5 w-full text-xs">
            <tbody>
              {p.days.map((d) => (
                <tr key={d.day} className="border-b border-slate-100 last:border-0">
                  <td className="py-1 pr-2 tabular-nums">{d.day}</td>
                  <td className="py-1 pr-2 text-slate-500">
                    заказов {d.ordersChanged} из {d.ordersTotal}
                    {d.orderNumbers.length > 0 && (
                      <span className="text-slate-400"> · {d.orderNumbers.slice(0, 4).join(", ")}</span>
                    )}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {d.shareBeforeCents != null ? formatCents(d.shareBeforeCents) : "—"} →{" "}
                    {d.shareAfterCents != null ? formatCents(d.shareAfterCents) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {p.warnings.map((w) => (
        <div key={w} className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          {w}
        </div>
      ))}
    </div>
  );
}

/** Исправление ошибочно введённой записи. Новый период не создаётся. */
export function CorrectSettingDialog({ actions, row }: { actions: SettingActions; row: SettingRowDto }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<SettingPreviewDto | null>(null);

  const [amount, setAmount] = useState(row.amountCents != null ? (row.amountCents / 100).toFixed(2) : "");
  const [percent, setPercent] = useState(row.percentBp != null ? (row.percentBp / 100).toFixed(2) : "");
  const [fixed, setFixed] = useState(row.fixedCents != null ? (row.fixedCents / 100).toFixed(2) : "");
  const [share, setShare] = useState(row.actualShareBp != null ? (row.actualShareBp / 100).toFixed(2) : "");
  // По умолчанию — существующая дата записи: исправляют обычно значение, а не период.
  const [from, setFrom] = useState(row.effectiveFrom);

  const touched = () => setPreview(null);

  const askPreview = () =>
    start(async () => {
      const r = await actions.preview({
        entity: row.entity,
        id: row.id,
        op: "CORRECT",
        amount,
        percent,
        fixed,
        share,
        effectiveFrom: from,
      });
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
        if (!v) setPreview(null);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Изменить
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Исправить запись</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-slate-500">
          Исправление меняет уже посчитанное: значение считается неверным с самого начала периода. Если ставка
          действительно изменилась с какого-то дня — закройте диалог и добавьте новую ставку с даты.
        </p>
        <form
          action={(fd) =>
            start(async () => {
              const res = await actions.correct(fd);
              if (res.error) {
                toast.error(res.error);
                return;
              }
              toast.success(res.message ?? "Исправлено");
              setOpen(false);
              setPreview(null);
            })
          }
          className="space-y-3"
        >
          <input type="hidden" name="entity" value={row.entity} />
          <input type="hidden" name="id" value={row.id} />

          {row.entity === "CONSUMABLES_RATE" && (
            <Field label="Сумма на заказ">
              <Input name="amount" inputMode="decimal" required value={amount} onChange={(e) => { setAmount(e.target.value); touched(); }} />
            </Field>
          )}
          {row.entity === "FEE_MODEL" && (
            <>
              <Field label="Процент, %">
                <Input name="percent" inputMode="decimal" required value={percent} onChange={(e) => { setPercent(e.target.value); touched(); }} />
              </Field>
              <Field label="Фиксированная часть">
                <Input name="fixed" inputMode="decimal" required value={fixed} onChange={(e) => { setFixed(e.target.value); touched(); }} />
              </Field>
            </>
          )}
          {row.entity === "TAX_POLICY" && (
            <Field label="Доля налога как расхода, %" hint="Флористам не показывается: в их базе налог вычитается полностью.">
              <Input name="share" inputMode="decimal" required value={share} onChange={(e) => { setShare(e.target.value); touched(); }} />
            </Field>
          )}

          <Field label="Действует с" hint="Меняется вместе с концом предыдущего периода — дыры не появится.">
            <Input name="effectiveFrom" type="date" required value={from} onChange={(e) => { setFrom(e.target.value); touched(); }} />
          </Field>

          <Field label="Причина исправления" hint="Обязательна: уходит в историю изменений.">
            <Textarea name="reason" rows={2} required />
          </Field>

          {preview && <PreviewPanel p={preview} />}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={askPreview}>
              {pending ? "Считаю…" : "Показать, что изменится"}
            </Button>
            <Button type="submit" disabled={pending || preview == null}>
              {pending ? "Сохраняю…" : "Исправить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Удаление ошибочной записи. Отрезок забирает предыдущий период. */
export function DeleteSettingDialog({ actions, row }: { actions: SettingActions; row: SettingRowDto }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<SettingPreviewDto | null>(null);

  const load = () =>
    start(async () => {
      const r = await actions.preview({ entity: row.entity, id: row.id, op: "DELETE" });
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
          <DialogTitle>Удалить запись настройки</DialogTitle>
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
          <input type="hidden" name="entity" value={row.entity} />
          <input type="hidden" name="id" value={row.id} />
          {preview ? <PreviewPanel p={preview} /> : <p className="text-sm text-slate-400">Считаю последствия…</p>}
          <Field label="Причина удаления" hint="Обязательна: запись останется в истории изменений.">
            <Textarea name="reason" rows={2} required />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending || preview == null}>
              {pending ? "Удаляю…" : "Удалить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
