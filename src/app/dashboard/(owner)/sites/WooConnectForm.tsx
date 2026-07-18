"use client";
import { useActionState } from "react";
import { ownerConnectWoo } from "./wooActions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { WooConnectionInstructions } from "./WooConnectionInstructions";

/**
 * Форма подключения WooCommerce. URL магазина — корень сайта (https://example.com); Floremart
 * сам собирает /wp-json/wc/v3. Consumer Secret не отображается после сохранения (хранится
 * зашифрованно, в карточке — только маска).
 */
export function WooConnectForm() {
  const [state, formAction, pending] = useActionState(ownerConnectWoo, null);

  return (
    <div className="space-y-3">
      <WooConnectionInstructions />
      <form action={formAction} className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="woo-name">Название магазина</Label>
          <Input id="woo-name" name="name" placeholder="Bloom Shop" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="woo-url">URL магазина</Label>
          <Input id="woo-url" name="storeUrl" placeholder="https://example.com" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="woo-ck">Consumer Key</Label>
          <Input id="woo-ck" name="consumerKey" autoComplete="off" placeholder="ck_..." required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="woo-cs">Consumer Secret</Label>
          <Input id="woo-cs" name="consumerSecret" type="password" autoComplete="off" placeholder="cs_..." required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="woo-apiv">Версия API</Label>
          <Input id="woo-apiv" name="apiVersion" defaultValue="wc/v3" placeholder="wc/v3" />
          <p className="text-xs text-slate-400">API path задаётся автоматически — меняйте только если стандартный endpoint недоступен.</p>
        </div>
        <div className="flex items-end">
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Проверяем…" : "Проверить подключение"}
          </Button>
        </div>
      </form>
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state?.ok && <p className="text-sm text-emerald-700">{state.message}</p>}
      <p className="text-xs text-slate-400">
        Consumer Secret и webhook secret хранятся зашифрованно (AES-256-GCM) и не отображаются. Требуется HTTPS.
      </p>
    </div>
  );
}
