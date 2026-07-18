"use client";
import { useState } from "react";
import { CustomAppConnectForm } from "./CustomAppConnectForm";
import { ConnectShopifyForm } from "./ConnectShopifyForm";
import { WooConnectForm } from "./WooConnectForm";
import { cn } from "@/lib/cn";

/** Выбор платформы и способа подключения магазина: Shopify (Custom App / OAuth) или WooCommerce. */
export function SiteConnectPanel() {
  const [platform, setPlatform] = useState<"shopify" | "woocommerce">("shopify");
  const [tab, setTab] = useState<"custom" | "oauth">("custom");

  const platBtn = (id: "shopify" | "woocommerce", label: string) => (
    <button
      type="button"
      onClick={() => setPlatform(id)}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-semibold",
        platform === id ? "bg-white text-slate-900 shadow-xs" : "text-slate-500 hover:text-slate-700"
      )}
      aria-pressed={platform === id}
    >
      {label}
    </button>
  );

  const tabBtn = (id: "custom" | "oauth", label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium",
        tab === id ? "bg-white text-slate-900 shadow-xs" : "text-slate-500 hover:text-slate-700"
      )}
      aria-pressed={tab === id}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="inline-flex gap-1 rounded-lg bg-slate-100 p-1">
        {platBtn("shopify", "Shopify")}
        {platBtn("woocommerce", "WooCommerce")}
      </div>

      {platform === "shopify" ? (
        <div className="space-y-3">
          <div className="inline-flex gap-1 rounded-lg bg-slate-100 p-1">
            {tabBtn("custom", "Подключить Custom App")}
            {tabBtn("oauth", "Подключить через OAuth")}
          </div>
          {tab === "custom" ? (
            <CustomAppConnectForm />
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">Legacy: подключение через общее OAuth-приложение (для ранее подключённых магазинов).</p>
              <ConnectShopifyForm />
            </div>
          )}
        </div>
      ) : (
        <WooConnectForm />
      )}
    </div>
  );
}
