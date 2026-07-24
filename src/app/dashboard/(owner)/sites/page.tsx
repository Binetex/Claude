import { prisma } from "@/lib/db";
import { REQUIRED_WEBHOOK_TOPICS } from "@/integrations/shopify/customApp/webhookRegistration";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SiteConnectPanel } from "./SiteConnectPanel";
import { SiteCardActions } from "./SiteCardActions";
import { SiteNameForm } from "./SiteNameForm";
import { SiteSyncControls } from "./SiteSyncControls";
import { WooSiteControls } from "./WooSiteControls";
import { WooSettings } from "./WooSettings";
import { AirwallexMonitoringPanel } from "./AirwallexMonitoringPanel";
import { SiteTimezoneSetting } from "./SiteTimezoneSetting";
import { SiteBurqDropoffSetting } from "./SiteBurqDropoffSetting";
import { SiteQuoSetting } from "./SiteQuoSetting";
import { SiteQuoWebhookSecurity } from "./SiteQuoWebhookSecurity";
import { listQuoSigningSecretsMasked } from "@/integrations/quo/signingSecrets";
import { getQuoSigningKeys } from "@/integrations/quo/config";
import { isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";
import { diffScopes } from "@/integrations/shopify/customApp/scopes";
import type { SyncStatusSnapshot } from "@/app/dashboard/(owner)/actions";

const connStatusMeta: Record<string, { label: string; className: string }> = {
  CONNECTING: { label: "Проверка…", className: "bg-amber-100 text-amber-800 border-amber-200" },
  CONNECTED: { label: "Подключён", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  DEGRADED: { label: "Ограниченный доступ", className: "bg-orange-100 text-orange-800 border-orange-200" },
  REAUTH_REQUIRED: { label: "Требуется переподключение", className: "bg-red-100 text-red-800 border-red-200" },
  DISCONNECTED: { label: "Отключён", className: "bg-slate-100 text-slate-600 border-slate-200" },
};

export const dynamic = "force-dynamic";

export default async function SitesPage() {
  // Явный select: НЕ тянем зашифрованные секреты (clientSecretEncrypted/accessTokenEncrypted/…)
  // и лишние поля (user.passwordHash) в серверную память — только то, что реально рендерится.
  const sites = await prisma.site.findMany({
    select: {
      id: true, name: true, shortName: true, platform: true, colorTag: true,
      connectionStatus: true, shopifyShopDomain: true, timezone: true, burqDefaultDropoffInstructions: true,
      quoPhoneNumberId: true, quoPhoneNumber: true, quoEnabled: true, quoLastCheckAt: true, quoConnectionError: true,
      authMode: true, shopifyConnStatus: true, lastConnectionCheckAt: true, lastSyncAt: true,
      grantedScopes: true, connectionError: true,
      webhooks: { select: { topic: true, status: true } },
      floristPriorities: {
        orderBy: { position: "asc" },
        select: { id: true, position: true, florist: { select: { user: { select: { name: true } } } } },
      },
      syncs: {
        select: {
          kind: true, status: true, total: true, processed: true, created: true,
          updated: true, skipped: true, errors: true, errorMessage: true, finishedAt: true,
        },
      },
      // WooCommerce: НЕ тянем зашифрованные секреты — только отображаемые поля + маску.
      wooConnection: {
        select: {
          storeUrl: true, apiBaseUrl: true, connStatus: true, connectionError: true,
          storeName: true, currency: true, wooVersion: true, wpVersion: true,
          consumerSecretMask: true, lastConnectionCheckAt: true, lastProductSyncAt: true, lastOrderSyncAt: true,
          orderMetaMapping: true, airwallexEnabled: true, klarnaPayLaterPendingIsConfirmed: true,
          airwallexPaymentMethodIds: true, airwallexMetaKeys: true, payLaterMaxWaitMinutes: true, unknownBehavior: true,
          airwallexMonitoringEnabled: true, airwallexApiClientIdEncrypted: true, airwallexApiKeyEncrypted: true,
          airwallexApiKeyMask: true, airwallexApiEnv: true, airwallexPendingThresholdMin: true,
          airwallexApiVerifiedAt: true, airwallexApiConnStatus: true, airwallexApiErrorSafe: true,
        },
      },
      _count: { select: { orders: true, products: true, wooWebhooks: true } },
    },
    orderBy: { name: "asc" },
  });

  const snapshot = (syncs: (typeof sites)[number]["syncs"]): SyncStatusSnapshot => {
    const pick = (kind: "PRODUCTS" | "ORDERS") => {
      const r = syncs.find((x) => x.kind === kind);
      if (!r) return null;
      return {
        status: r.status,
        total: r.total,
        processed: r.processed,
        created: r.created,
        updated: r.updated,
        skipped: r.skipped,
        errors: r.errors,
        errorMessage: r.errorMessage,
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      };
    };
    return { products: pick("PRODUCTS"), orders: pick("ORDERS") };
  };

  const quoSecrets = await listQuoSigningSecretsMasked(prisma).catch(() => []);
  const quoEnvCount = getQuoSigningKeys().length;
  const quoCrypto = isCredentialCryptoConfigured();

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Сайты</h1>

      <Card className="p-4">
        <div className="mb-2 text-sm font-semibold text-slate-700">Подключить новый магазин</div>
        <SiteConnectPanel />
      </Card>

      <SiteQuoWebhookSecurity
        secrets={quoSecrets.map((s) => ({ id: s.id, maskedSuffix: s.maskedSuffix, createdAt: s.createdAt.toISOString() }))}
        envCount={quoEnvCount}
        cryptoConfigured={quoCrypto}
      />

      <div className="grid gap-4 md:grid-cols-2">
        {sites.map((s) => (
          <Card key={s.id}>
            <CardHeader className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: s.colorTag }} />
                <SiteNameForm siteId={s.id} name={s.name} />
              </div>
              <Badge className={s.connectionStatus === "CONNECTED" ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-slate-100 text-slate-600 border-slate-200"}>
                {s.connectionStatus === "CONNECTED" ? "Подключён" : s.connectionStatus}
              </Badge>
            </CardHeader>
            <CardBody className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div><div className="text-xs text-slate-400">Короткое имя</div>{s.shortName}</div>
                <div><div className="text-xs text-slate-400">Платформа</div>{s.platform}</div>
                <div><div className="text-xs text-slate-400">Заказов / товаров</div>{s._count.orders} / {s._count.products}</div>
                {s.shopifyShopDomain && (
                  <div className="col-span-2">
                    <div className="text-xs text-slate-400">Домен Shopify</div>{s.shopifyShopDomain}
                  </div>
                )}
              </div>
              {s.platform === "WOOCOMMERCE" && s.wooConnection && (
                <div className="space-y-2 border-t border-slate-100 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-400">Подключение:</span>
                    <Badge className="bg-slate-100 text-slate-700 border-slate-200">WooCommerce</Badge>
                    <Badge className={(connStatusMeta[s.wooConnection.connStatus] ?? connStatusMeta.DISCONNECTED).className}>
                      {(connStatusMeta[s.wooConnection.connStatus] ?? { label: s.wooConnection.connStatus }).label}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-slate-500">
                    <div className="col-span-2"><span className="text-slate-400">URL:</span> {s.wooConnection.storeUrl}</div>
                    <div><span className="text-slate-400">Валюта:</span> {s.wooConnection.currency ?? "—"}</div>
                    <div><span className="text-slate-400">WooCommerce:</span> {s.wooConnection.wooVersion ?? "—"}</div>
                    <div><span className="text-slate-400">Webhooks:</span> {s._count.wooWebhooks}</div>
                    <div><span className="text-slate-400">Проверка:</span> {s.wooConnection.lastConnectionCheckAt ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(s.wooConnection.lastConnectionCheckAt) : "—"}</div>
                    <div><span className="text-slate-400">Секрет:</span> {s.wooConnection.consumerSecretMask || "—"}</div>
                  </div>
                  {s.wooConnection.connectionError && <div className="text-xs text-orange-700">{s.wooConnection.connectionError}</div>}
                  <WooSiteControls siteId={s.id} snapshot={snapshot(s.syncs)} connected={s.wooConnection.connStatus === "CONNECTED" || s.wooConnection.connStatus === "DEGRADED"} storeUrl={s.wooConnection.storeUrl} />
                  <WooSettings
                    siteId={s.id}
                    metaMapping={(s.wooConnection.orderMetaMapping as Record<string, string> | null) ?? null}
                    payment={{
                      airwallexEnabled: s.wooConnection.airwallexEnabled,
                      klarnaPayLaterPendingIsConfirmed: s.wooConnection.klarnaPayLaterPendingIsConfirmed,
                      airwallexPaymentMethodIds: s.wooConnection.airwallexPaymentMethodIds,
                      paymentIntentStatusKey: (s.wooConnection.airwallexMetaKeys as { paymentIntentStatusKey?: string } | null)?.paymentIntentStatusKey ?? null,
                      payLaterMaxWaitMinutes: s.wooConnection.payLaterMaxWaitMinutes,
                      unknownBehavior: s.wooConnection.unknownBehavior,
                    }}
                  />
                  <AirwallexMonitoringPanel
                    siteId={s.id}
                    initial={{
                      monitoringEnabled: s.wooConnection.airwallexMonitoringEnabled,
                      clientIdConfigured: !!s.wooConnection.airwallexApiClientIdEncrypted,
                      apiKeyConfigured: !!s.wooConnection.airwallexApiKeyEncrypted,
                      apiKeyMask: s.wooConnection.airwallexApiKeyMask,
                      env: s.wooConnection.airwallexApiEnv === "demo" ? "demo" : "prod",
                      pendingThresholdMin: s.wooConnection.airwallexPendingThresholdMin,
                      verifiedAt: s.wooConnection.airwallexApiVerifiedAt ? s.wooConnection.airwallexApiVerifiedAt.toISOString() : null,
                      connStatus: s.wooConnection.airwallexApiConnStatus,
                      errorSafe: s.wooConnection.airwallexApiErrorSafe,
                      cryptoConfigured: quoCrypto,
                    }}
                  />
                </div>
              )}

              {s.authMode === "CUSTOM_APP" && (
                <div className="space-y-2 border-t border-slate-100 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-400">Подключение:</span>
                    <Badge className="bg-slate-100 text-slate-700 border-slate-200">Custom App</Badge>
                    {s.shopifyConnStatus && (
                      <Badge className={(connStatusMeta[s.shopifyConnStatus] ?? connStatusMeta.DISCONNECTED).className}>
                        {(connStatusMeta[s.shopifyConnStatus] ?? { label: s.shopifyConnStatus }).label}
                      </Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-slate-500">
                    <div><span className="text-slate-400">Последняя проверка:</span> {s.lastConnectionCheckAt ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(s.lastConnectionCheckAt) : "—"}</div>
                    <div><span className="text-slate-400">Последняя синхр.:</span> {s.lastSyncAt ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(s.lastSyncAt) : "—"}</div>
                  </div>
                  {(() => {
                    const missing = diffScopes(s.grantedScopes).missing;
                    return missing.length ? (
                      <div className="text-xs text-orange-700">Не хватает scopes: {missing.join(", ")}</div>
                    ) : null;
                  })()}
                  {(() => {
                    // Без подписок магазин молча не получает заказы — показываем это явно.
                    const active = s.webhooks.filter((w) => w.status === "ACTIVE").length;
                    const hasOrders = s.webhooks.some((w) => w.topic === "ORDERS_CREATE" && w.status === "ACTIVE");
                    if (active >= REQUIRED_WEBHOOK_TOPICS.length && hasOrders) {
                      return <div className="text-xs text-emerald-700">Подписки на webhook: {active} активных ✓</div>;
                    }
                    return (
                      <div className="text-xs text-orange-700">
                        Подписки на webhook: {active} из {REQUIRED_WEBHOOK_TOPICS.length}
                        {hasOrders ? "" : " — нет ORDERS_CREATE, новые заказы не придут"}. Нажмите «Проверить подписки».
                      </div>
                    );
                  })()}
                  {s.connectionError && <div className="text-xs text-red-600">{s.connectionError}</div>}
                  <SiteCardActions siteId={s.id} />
                </div>
              )}

              <SiteTimezoneSetting siteId={s.id} current={s.timezone} />

              <SiteBurqDropoffSetting siteId={s.id} current={s.burqDefaultDropoffInstructions} />

              <SiteQuoSetting
                siteId={s.id}
                current={{
                  quoPhoneNumberId: s.quoPhoneNumberId,
                  quoPhoneNumber: s.quoPhoneNumber,
                  quoEnabled: s.quoEnabled,
                  quoLastCheckAt: s.quoLastCheckAt ? s.quoLastCheckAt.toISOString() : null,
                  quoConnectionError: s.quoConnectionError,
                }}
              />

              <div>
                <div className="mb-1 text-xs text-slate-400">Приоритет флористов</div>
                <ol className="space-y-1">
                  {s.floristPriorities.map((p) => (
                    <li key={p.id} className="flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-xs text-white">{p.position + 1}</span>
                      <span className="text-slate-700">{p.florist.user.name}</span>
                      {p.position === 0 && <span className="text-xs text-emerald-600">основной</span>}
                    </li>
                  ))}
                </ol>
              </div>
              {s.platform !== "WOOCOMMERCE" && s.connectionStatus === "CONNECTED" && (
                <div className="border-t border-slate-100 pt-3">
                  <div className="mb-1.5 text-xs text-slate-400">Синхронизация</div>
                  <SiteSyncControls siteId={s.id} initial={snapshot(s.syncs)} />
                </div>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
      <p className="text-xs text-slate-400">
        Реальные API (WooCommerce/Shopify) на этапе 1 не подключаются — структура готова под интеграции через адаптеры.
      </p>
    </div>
  );
}
