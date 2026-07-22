"use client";
import { useActionState, useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ownerUpdateWooCredentials, ownerSaveWooMetaMapping, ownerSaveWooPaymentConfig, ownerFetchWooMetaKeys } from "./wooActions";

export type WooPaymentSettings = {
  airwallexEnabled: boolean;
  klarnaPayLaterPendingIsConfirmed: boolean;
  airwallexPaymentMethodIds: string[];
  paymentIntentStatusKey: string | null;
  payLaterMaxWaitMinutes: number;
  unknownBehavior: string;
};

const META_FIELDS: [keyof Record<string, string>, string][] = [
  ["deliveryDate", "Дата доставки"],
  ["deliveryWindow", "Окно доставки"],
  ["recipientName", "Имя получателя"],
  ["recipientPhone", "Телефон получателя"],
  ["apartment", "Квартира/офис"],
  ["cardMessage", "Текст открытки"],
  ["deliveryInstructions", "Инструкции доставки"],
  ["occasion", "Повод"],
  ["senderName", "Имя отправителя"],
];

/** Настройки WooCommerce-магазина: credentials, сопоставление полей заказа, Airwallex/Klarna. */
export function WooSettings({
  siteId,
  metaMapping,
  payment,
}: {
  siteId: string;
  metaMapping: Record<string, string> | null;
  payment: WooPaymentSettings;
}) {
  const [credState, credAction, credPending] = useActionState(ownerUpdateWooCredentials, null);
  const [metaState, metaAction, metaPending] = useActionState(ownerSaveWooMetaMapping, null);
  const [payState, payAction, payPending] = useActionState(ownerSaveWooPaymentConfig, null);
  const [keys, setKeys] = useState<{ key: string; count: number }[] | null>(null);
  const [keysErr, setKeysErr] = useState<string | null>(null);
  const [fetching, startFetch] = useTransition();

  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-slate-700">Настройки WooCommerce</summary>

      {/* ── Обновить credentials ── */}
      <form action={credAction} className="mt-3 space-y-2 border-b border-slate-200 pb-3">
        <input type="hidden" name="siteId" value={siteId} />
        <div className="text-xs font-semibold text-slate-600">Изменить credentials</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input name="consumerKey" placeholder="Consumer Key" autoComplete="off" required />
          <Input name="consumerSecret" type="password" placeholder="Consumer Secret" autoComplete="off" required />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={credPending}>{credPending ? "…" : "Обновить и проверить"}</Button>
        {credState?.error && <p className="text-xs text-red-600">{credState.error}</p>}
        {credState?.ok && <p className="text-xs text-emerald-700">{credState.message}</p>}
      </form>

      {/* ── Сопоставление полей заказа ── */}
      <form action={metaAction} className="mt-3 space-y-2 border-b border-slate-200 pb-3">
        <input type="hidden" name="siteId" value={siteId} />
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-slate-600">Сопоставление полей заказа → Woo meta key</div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={fetching}
            onClick={() =>
              startFetch(async () => {
                setKeysErr(null);
                const r = await ownerFetchWooMetaKeys(siteId);
                if (r.ok) setKeys(r.keys ?? []);
                else setKeysErr(r.error ?? "Ошибка");
              })
            }
          >
            {fetching ? "…" : "Подтянуть ключи из заказов"}
          </Button>
        </div>
        {keysErr && <p className="text-xs text-red-600">{keysErr}</p>}
        {keys && (
          <p className="text-xs text-slate-500">
            Найденные ключи: {keys.length ? keys.map((k) => `${k.key} (${k.count})`).join(", ") : "нет"}
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {META_FIELDS.map(([field, label]) => (
            <div key={String(field)} className="space-y-1">
              <Label htmlFor={`meta-${String(field)}`} className="text-xs">{label}</Label>
              <Input id={`meta-${String(field)}`} name={String(field)} defaultValue={metaMapping?.[String(field)] ?? ""} placeholder="_meta_key" autoComplete="off" />
            </div>
          ))}
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={metaPending}>{metaPending ? "…" : "Сохранить сопоставление"}</Button>
        {metaState?.error && <p className="text-xs text-red-600">{metaState.error}</p>}
        {metaState?.ok && <p className="text-xs text-emerald-700">{metaState.message}</p>}
      </form>

      {/* ── Airwallex / Klarna ── */}
      <form action={payAction} className="mt-3 space-y-2">
        <input type="hidden" name="siteId" value={siteId} />
        <div className="text-xs font-semibold text-slate-600">Airwallex / Klarna Pay Later</div>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" name="airwallexEnabled" defaultChecked={payment.airwallexEnabled} /> Включить распознавание Airwallex/BNPL
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" name="klarnaPayLaterPendingIsConfirmed" defaultChecked={payment.klarnaPayLaterPendingIsConfirmed} /> Считать pending BNPL как одобренную оплату
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">payment_method ID (через запятую)</Label>
            <Input name="airwallexPaymentMethodIds" defaultValue={payment.airwallexPaymentMethodIds.join(",")} placeholder="airwallex_klarna,airwallex_paylater" autoComplete="off" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Meta-ключ статуса Airwallex</Label>
            <Input name="paymentIntentStatusKey" defaultValue={payment.paymentIntentStatusKey ?? ""} placeholder="_airwallex_payment_status" autoComplete="off" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Макс. ожидание финала (мин)</Label>
            <Input name="payLaterMaxWaitMinutes" type="number" defaultValue={payment.payLaterMaxWaitMinutes} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Поведение при UNKNOWN</Label>
            <select name="unknownBehavior" defaultValue={payment.unknownBehavior} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              <option value="HOLD">HOLD (удержать)</option>
              <option value="AWAITING_PAYMENT">AWAITING_PAYMENT</option>
            </select>
          </div>
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={payPending}>{payPending ? "…" : "Сохранить настройки оплаты"}</Button>
        {payState?.error && <p className="text-xs text-red-600">{payState.error}</p>}
        {payState?.ok && <p className="text-xs text-emerald-700">{payState.message}</p>}
        <p className="text-[11px] text-slate-400">Значения признаков Airwallex/Klarna заполняются по анализу реальных старых заказов того магазина, где были такие оплаты.</p>
      </form>
    </details>
  );
}
