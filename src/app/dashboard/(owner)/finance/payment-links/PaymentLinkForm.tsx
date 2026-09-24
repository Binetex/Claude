"use client";
/**
 * Два поля и кнопка. Готовая ссылка показывается крупно и с кнопкой «Скопировать» — её сразу
 * отправляют клиенту, и заставлять выделять текст мышкой на телефоне незачем.
 */
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardBody } from "@/components/ui/Card";
import { createPaymentLinkAction } from "./actions";

export function PaymentLinkForm({ accountName }: { accountName: string }) {
  const [state, action, pending] = useActionState(createPaymentLinkAction, null);
  const [copied, setCopied] = useState(false);

  return (
    <Card>
      <CardBody className="space-y-3">
        {state?.ok && state.url && (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3">
            <p className="text-xs font-medium text-emerald-800">Ссылка готова</p>
            <p className="mt-1 break-all font-mono text-sm text-emerald-900">{state.url}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(state.url!);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  /* буфер недоступен — ссылку видно на экране, её можно выделить руками */
                }
              }}
            >
              {copied ? "Скопировано" : "Скопировать"}
            </Button>
          </div>
        )}
        {state?.error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{state.error}</p>}

        <form action={action} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500" htmlFor="title">
              Название — его увидит клиент на странице оплаты
            </label>
            <Input id="title" name="title" placeholder="Dozen Scarlet Roses + CA tax" autoComplete="off" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500" htmlFor="amount">
              Сумма, USD
            </label>
            <Input id="amount" name="amount" inputMode="decimal" placeholder="113.40" autoComplete="off" className="max-w-[180px]" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? "Создаю ссылку…" : "Создать ссылку"}
            </Button>
            <span className="text-[11px] text-slate-400">Счёт от {accountName} · одноразовая ссылка</span>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
