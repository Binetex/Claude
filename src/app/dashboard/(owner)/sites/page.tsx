import { prisma } from "@/lib/db";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ConnectShopifyForm } from "./ConnectShopifyForm";
import { SiteNameForm } from "./SiteNameForm";
import { SiteSyncControls } from "./SiteSyncControls";
import type { SyncStatusSnapshot } from "@/app/dashboard/(owner)/actions";

export const dynamic = "force-dynamic";

export default async function SitesPage() {
  const sites = await prisma.site.findMany({
    include: {
      floristPriorities: { orderBy: { position: "asc" }, include: { florist: { include: { user: true } } } },
      syncs: true,
      _count: { select: { orders: true, products: true } },
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

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Сайты</h1>

      <Card className="p-4">
        <div className="mb-2 text-sm font-semibold text-slate-700">Подключить новый магазин Shopify</div>
        <ConnectShopifyForm />
      </Card>

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
              {s.connectionStatus === "CONNECTED" && (
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
