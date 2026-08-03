"use client";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { floristSetPrimaryPickupLocation } from "./pickupActions";

export type FloristPickupOption = {
  id: string;
  isPrimary: boolean;
  isActive: boolean;
  locationName: string;
  addressLine: string;
  apartmentOrSuite: string | null;
  city: string;
  state: string;
  zip: string;
};

/** Выбор основной точки: по одной форме на точку — жмём кнопку у нужной. */
export function PickupChoice({ locations }: { locations: FloristPickupOption[] }) {
  const [state, action, pending] = useActionState(floristSetPrimaryPickupLocation, null);

  return (
    <div className="space-y-2">
      {locations.map((l) => (
        <form
          key={l.id}
          action={action}
          className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 ${
            l.isPrimary ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white"
          }`}
        >
          <input type="hidden" name="id" value={l.id} />
          <div className="text-sm">
            <div className="font-medium text-slate-800">
              {l.locationName}
              {l.isPrimary && <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">основная</span>}
              {!l.isActive && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">отключена</span>}
            </div>
            <div className="text-xs text-slate-500">
              {l.addressLine}
              {l.apartmentOrSuite ? `, ${l.apartmentOrSuite}` : ""}, {l.city} {l.state} {l.zip}
            </div>
          </div>
          {!l.isPrimary && l.isActive && (
            <Button type="submit" size="sm" variant="outline" disabled={pending}>
              {pending ? "…" : "Сделать основной"}
            </Button>
          )}
        </form>
      ))}
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state?.ok && <p className="text-sm text-emerald-700">{state.message}</p>}
    </div>
  );
}
