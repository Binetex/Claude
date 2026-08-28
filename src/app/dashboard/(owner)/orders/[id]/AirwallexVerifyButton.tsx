"use client";
import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { verifyAirwallexAction } from "./airwallexActions";

/**
 * «Проверить сейчас». Опрос по расписанию редкий (после неудачной попытки — раз в шесть часов),
 * и без этой кнопки владелец, видящий в кабинете Airwallex прошедший платёж, не мог сделать
 * ничего, кроме как ждать.
 */
export function AirwallexVerifyButton({ orderId }: { orderId: string }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setMsg(null);
            const res = await verifyAirwallexAction(orderId);
            setMsg(res.error ? { ok: false, text: res.error } : { ok: true, text: res.message ?? "Проверено." });
          })
        }
      >
        <RefreshCw className={`size-4 ${pending ? "animate-spin" : ""}`} />
        {pending ? "Спрашиваю Airwallex…" : "Проверить сейчас"}
      </Button>
      {msg && <span className={`text-xs ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</span>}
    </div>
  );
}
