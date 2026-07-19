"use client";
import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ownerSavePickupLocation } from "./pickupActions";

export type PickupLocationValue = {
  locationName: string;
  contactName: string;
  contactPhone: string;
  addressLine: string;
  apartmentOrSuite: string | null;
  city: string;
  state: string;
  zip: string;
  courierInstructions: string | null;
  isActive: boolean;
} | null;

/**
 * Форма настройки точки забора флориста (обязательна для авто-создания Burq draft).
 * Пока точка не заполнена — заказы этого флориста ждут (WAITING_FOR_FLORIST), черновик не создаётся.
 */
export function PickupLocationEditor({ floristId, value }: { floristId: string; value: PickupLocationValue }) {
  const [state, action, pending] = useActionState(ownerSavePickupLocation, null);
  const configured = !!value;

  return (
    <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-slate-700">
        Точка забора (pickup){" "}
        <span className={configured ? "text-emerald-600" : "text-amber-600"}>
          · {configured ? (value!.isActive ? "настроена" : "отключена") : "не настроена"}
        </span>
      </summary>

      <form action={action} className="mt-3 space-y-2">
        <input type="hidden" name="floristId" value={floristId} />
        <div className="space-y-1">
          <Label className="text-xs">Название точки</Label>
          <Input name="locationName" defaultValue={value?.locationName ?? ""} placeholder="Main Studio" autoComplete="off" required />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">Контактное лицо</Label>
            <Input name="contactName" defaultValue={value?.contactName ?? ""} placeholder="Имя" autoComplete="off" required />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Телефон (E.164)</Label>
            <Input name="contactPhone" defaultValue={value?.contactPhone ?? ""} placeholder="+13105550198" autoComplete="off" required />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Адрес</Label>
          <Input name="addressLine" defaultValue={value?.addressLine ?? ""} placeholder="200 Market St" autoComplete="off" required />
        </div>
        <div className="grid gap-2 sm:grid-cols-4">
          <div className="space-y-1 sm:col-span-1">
            <Label className="text-xs">Кв./офис</Label>
            <Input name="apartmentOrSuite" defaultValue={value?.apartmentOrSuite ?? ""} placeholder="Suite 5" autoComplete="off" />
          </div>
          <div className="space-y-1 sm:col-span-1">
            <Label className="text-xs">Город</Label>
            <Input name="city" defaultValue={value?.city ?? ""} placeholder="Los Angeles" autoComplete="off" required />
          </div>
          <div className="space-y-1 sm:col-span-1">
            <Label className="text-xs">Штат</Label>
            <Input name="state" defaultValue={value?.state ?? ""} placeholder="CA" maxLength={2} autoComplete="off" required />
          </div>
          <div className="space-y-1 sm:col-span-1">
            <Label className="text-xs">ZIP</Label>
            <Input name="zip" defaultValue={value?.zip ?? ""} placeholder="90013" autoComplete="off" required />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Инструкции курьеру (необязательно)</Label>
          <Input name="courierInstructions" defaultValue={value?.courierInstructions ?? ""} placeholder="Позвонить на входе" autoComplete="off" />
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" name="isActive" value="1" defaultChecked={value?.isActive ?? true} /> Точка активна (используется для создания доставки)
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>{pending ? "…" : "Сохранить точку забора"}</Button>
        {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
        {state?.ok && <p className="text-xs text-emerald-700">{state.message}</p>}
      </form>
    </details>
  );
}
