"use client";
import { useActionState, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ownerSavePickupLocation, ownerSetPrimaryPickupLocation } from "./pickupActions";

export type PickupLocationValue = {
  id: string;
  isPrimary: boolean;
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
};

/** Форма одной точки: создание (value=null) либо правка существующей. */
function PickupForm({ floristId, value, onSaved }: { floristId: string; value: PickupLocationValue | null; onSaved?: () => void }) {
  const [state, action, pending] = useActionState(ownerSavePickupLocation, null);
  const saved = !!state?.ok;
  useEffect(() => {
    if (saved) onSaved?.();
  }, [saved, onSaved]);

  return (
    <form action={action} className="mt-2 space-y-2">
      <input type="hidden" name="floristId" value={floristId} />
      {value && <input type="hidden" name="id" value={value.id} />}
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
        <input type="checkbox" name="isActive" value="1" defaultChecked={value?.isActive ?? true} /> Точка активна (доступна для создания доставки)
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "…" : value ? "Сохранить точку" : "Добавить точку"}
      </Button>
      {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
      {state?.ok && <p className="text-xs text-emerald-700">{state.message}</p>}
    </form>
  );
}

/** Кнопка «Сделать основной» — отдельная форма, чтобы не смешивать с сохранением полей. */
function MakePrimaryButton({ floristId, locationId }: { floristId: string; locationId: string }) {
  const [state, action, pending] = useActionState(ownerSetPrimaryPickupLocation, null);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="floristId" value={floristId} />
      <input type="hidden" name="id" value={locationId} />
      <Button type="submit" size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={pending}>
        {pending ? "…" : "Сделать основной"}
      </Button>
      {state?.error && <span className="text-xs text-red-600">{state.error}</span>}
      {state?.ok && <span className="text-xs text-emerald-700">{state.message}</span>}
    </form>
  );
}

/**
 * Точки забора флориста. Основная (isPrimary) уходит в Burq для новых заказов; в конкретном
 * заказе её можно переключить на другую точку этого же флориста — там же пересоздаётся доставка.
 * Пока ни одной активной точки нет — заказы флориста ждут (WAITING_FOR_FLORIST).
 */
export function PickupLocationsEditor({ floristId, locations }: { floristId: string; locations: PickupLocationValue[] }) {
  const [adding, setAdding] = useState(false);
  const primary = locations.find((l) => l.isPrimary && l.isActive);
  const summary = locations.length === 0 ? "не настроена" : primary ? `основная: ${primary.locationName}` : "нет активной основной";

  return (
    <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-slate-700">
        Точки забора (pickup) <span className={primary ? "text-emerald-600" : "text-amber-600"}>· {summary}</span>
        {locations.length > 1 && <span className="text-slate-400"> · всего {locations.length}</span>}
      </summary>

      <div className="mt-3 space-y-3">
        {locations.map((l) => (
          <details key={l.id} className="rounded-lg border border-slate-200 bg-white p-2">
            <summary className="cursor-pointer text-slate-700">
              <span className="font-medium">{l.locationName}</span>
              <span className="text-xs text-slate-400"> · {l.addressLine}, {l.city} {l.state}</span>
              {l.isPrimary && <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">основная</span>}
              {!l.isActive && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">отключена</span>}
            </summary>
            {!l.isPrimary && l.isActive && (
              <div className="mt-2">
                <MakePrimaryButton floristId={floristId} locationId={l.id} />
              </div>
            )}
            <PickupForm floristId={floristId} value={l} />
          </details>
        ))}

        {locations.length === 0 && <p className="text-xs text-amber-600">Точек нет — заказы этого флориста ждут настройки pickup.</p>}

        {adding ? (
          <div className="rounded-lg border border-slate-200 bg-white p-2">
            <div className="text-xs font-medium text-slate-600">Новая точка</div>
            <PickupForm floristId={floristId} value={null} onSaved={() => setAdding(false)} />
          </div>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
            Добавить точку
          </Button>
        )}
      </div>
    </details>
  );
}
