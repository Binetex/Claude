"use client";
import { useActionState } from "react";
import { ownerConnectCustomApp } from "./actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ConnectionInstructions } from "./ConnectionInstructions";
import { DEFAULT_SHOPIFY_API_VERSION } from "@/integrations/shopify/customApp/client";

/**
 * Форма ручного подключения Shopify Custom App. Секреты (Client Secret) не отображаются после
 * сохранения — сервер хранит их зашифрованно и показывает только маску в карточке.
 */
export function CustomAppConnectForm() {
  const [state, formAction, pending] = useActionState(ownerConnectCustomApp, null);

  return (
    <div className="space-y-3">
      <ConnectionInstructions />
      <form action={formAction} className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ca-name">Название магазина</Label>
          <Input id="ca-name" name="name" placeholder="O'Hara Florist" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ca-domain">Shopify domain</Label>
          <Input id="ca-domain" name="domain" placeholder="my-store.myshopify.com" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ca-clientId">Client ID</Label>
          <Input id="ca-clientId" name="clientId" autoComplete="off" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ca-clientSecret">Client Secret</Label>
          <Input id="ca-clientSecret" name="clientSecret" type="password" autoComplete="off" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ca-apiVersion">API Version</Label>
          <Input id="ca-apiVersion" name="apiVersion" defaultValue={DEFAULT_SHOPIFY_API_VERSION} placeholder="2026-07" />
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
        Webhook signing secret вводить не нужно — для Shopify webhook используется Client Secret этого приложения.
        Client Secret и access token хранятся зашифрованно и не отображаются.
      </p>
    </div>
  );
}
