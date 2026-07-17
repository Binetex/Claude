"use client";
import { useActionState } from "react";
import { ownerConnectShopify } from "@/app/dashboard/(owner)/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export function ConnectShopifyForm() {
  const [state, formAction, pending] = useActionState(ownerConnectShopify, null);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor="shopDomain">Домен магазина Shopify</Label>
        <Input id="shopDomain" name="shopDomain" placeholder="my-shop.myshopify.com" required className="w-64" />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Переходим…" : "Подключить Shopify"}
      </Button>
      {state?.error && <span className="pb-2 text-sm text-red-600">{state.error}</span>}
    </form>
  );
}
