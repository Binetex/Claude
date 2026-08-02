"use client";
/**
 * Формы владельца: выплата, корректировка, отмена операции.
 *
 * Токен идемпотентности генерируется ОДИН РАЗ на открытие диалога и переотправляется как
 * есть: двойной клик или ретрай браузера не создаёт вторую выплату. После успеха токен
 * обновляется — следующая выплата будет новой операцией, а не дублем.
 */
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatCents } from "@/lib/cents";
import {
  ownerRecordPayment,
  ownerRecordAdjustment,
  ownerReverseEntry,
  ownerPreviewPayment,
} from "@/app/dashboard/(owner)/finance/financeActions";

const newToken = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function AddPaymentDialog({ floristId, outstandingCents }: { floristId: string; outstandingCents: number }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(newToken);
  const [amount, setAmount] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Предупреждение о переплате считает СЕРВЕР: остаток на клиенте может устареть, пока
  // диалог открыт, а «баланс уйдёт в минус» — решение, которое нельзя принимать по копии.
  // Сброс делает обработчик ввода, а не эффект: пустое поле — это не результат проверки.
  useEffect(() => {
    if (!open || !amount.trim()) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const res = await ownerPreviewPayment(floristId, amount);
      if (cancelled) return;
      setWarning(
        "ok" in res && res.requiresConfirmation
          ? `После выплаты баланс станет ${formatCents(res.outstandingAfterCents)} — это больше остатка.`
          : null
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [amount, floristId, open]);

  function changeAmount(value: string) {
    setAmount(value);
    // Старое предупреждение относится к прежней сумме — держать его до ответа сервера
    // значит показывать неверное число рядом с обязательной галочкой подтверждения.
    setWarning(null);
  }

  function submit(formData: FormData) {
    start(async () => {
      const res = await ownerRecordPayment(formData);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Готово");
      setToken(newToken());
      setAmount("");
      setWarning(null);
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Добавить выплату</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Выплата флористу</DialogTitle>
        </DialogHeader>
        <form action={submit} className="space-y-3">
          <input type="hidden" name="floristId" value={floristId} />
          <input type="hidden" name="token" value={token} />

          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            Остаток к выплате: <span className="font-semibold tabular-nums">{formatCents(outstandingCents)}</span>
          </div>

          <Field label="Сумма, $">
            <Input
              name="amount"
              inputMode="decimal"
              placeholder="100.00"
              value={amount}
              onChange={(e) => changeAmount(e.target.value)}
              required
            />
          </Field>
          <Field label="Дата">
            <Input name="date" type="date" defaultValue={today()} />
          </Field>
          <Field label="Способ (необязательно)">
            <Input name="method" placeholder="наличные / Zelle / перевод" />
          </Field>
          <Field label="Ссылка или номер (необязательно)">
            <Input name="reference" placeholder="номер перевода" />
          </Field>
          <Field label="Комментарий (необязательно)">
            <Textarea name="comment" rows={2} />
          </Field>

          {warning && (
            <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <input type="checkbox" name="confirmOverpayment" className="mt-0.5" required />
              <span>{warning} Подтверждаю, что выплачиваю больше остатка.</span>
            </label>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Сохраняю…" : "Записать выплату"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AddAdjustmentDialog({ floristId }: { floristId: string }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(newToken);
  const [kind, setKind] = useState<"BONUS" | "DEDUCTION" | "MANUAL_ADJUSTMENT">("BONUS");
  const [pending, start] = useTransition();

  function submit(formData: FormData) {
    start(async () => {
      const res = await ownerRecordAdjustment(formData);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Готово");
      setToken(newToken());
      setOpen(false);
    });
  }

  const kindBtn = (value: typeof kind, label: string) => (
    <button
      type="button"
      onClick={() => setKind(value)}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        kind === value ? "bg-white text-slate-900 shadow-xs" : "text-slate-500 hover:text-slate-800"
      }`}
    >
      {label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Добавить корректировку
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Бонус, удержание или корректировка</DialogTitle>
        </DialogHeader>
        <form action={submit} className="space-y-3">
          <input type="hidden" name="floristId" value={floristId} />
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="kind" value={kind} />

          <div className="inline-flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
            {kindBtn("BONUS", "Бонус")}
            {kindBtn("DEDUCTION", "Удержание")}
            {kindBtn("MANUAL_ADJUSTMENT", "Корректировка")}
          </div>

          {kind === "MANUAL_ADJUSTMENT" && (
            <Field label="Направление">
              <select
                name="direction"
                className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm shadow-xs"
                defaultValue="CREDIT"
              >
                <option value="CREDIT">Увеличить долг флористу</option>
                <option value="DEBIT">Уменьшить долг флористу</option>
              </select>
            </Field>
          )}

          <Field label="Сумма, $">
            <Input name="amount" inputMode="decimal" placeholder="20.00" required />
          </Field>
          <Field label="За что">
            <Input name="description" placeholder="Например: срочный заказ в выходной" required />
          </Field>
          <Field label="Дата">
            <Input name="date" type="date" defaultValue={today()} />
          </Field>
          <Field label="Заказ (необязательно)">
            <Input name="orderId" placeholder="id заказа, если операция связана с заказом" />
          </Field>
          <Field label={kind === "BONUS" ? "Комментарий (необязательно)" : "Причина (обязательно)"}>
            <Textarea name="comment" rows={2} required={kind !== "BONUS"} />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Сохраняю…" : "Записать"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Отмена операции. Кнопка показывается только у тех записей, которые можно отменить:
 * сама отмена не отменяется, дважды сторнировать нельзя (это же гарантирует БД).
 */
export function ReverseEntryButton({
  entryId,
  floristId,
  description,
}: {
  entryId: string;
  floristId: string;
  description: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  function submit(formData: FormData) {
    start(async () => {
      const res = await ownerReverseEntry(formData);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Готово");
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-slate-400 hover:text-red-600">
          Отменить
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Отменить операцию</DialogTitle>
        </DialogHeader>
        <form action={submit} className="space-y-3">
          <input type="hidden" name="entryId" value={entryId} />
          <input type="hidden" name="floristId" value={floristId} />
          <p className="text-sm text-slate-600">
            «{description}» не будет удалена — вместо этого появится зеркальная запись, которая её погасит.
            История останется полной.
          </p>
          <Field label="Причина">
            <Textarea name="comment" rows={2} placeholder="Например: выплата записана дважды" required />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Не отменять
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Отменяю…" : "Отменить операцию"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
