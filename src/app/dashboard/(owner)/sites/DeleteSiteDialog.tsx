"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ownerGetSiteDeletionImpact, ownerDeleteSite } from "./actions";
import type { SiteDeletionImpact } from "@/modules/sites/deletion";

/**
 * Полное удаление магазина — необратимое действие, поэтому диалог сначала СЧИТАЕТ, а
 * потом спрашивает.
 *
 * Отчёт запрашивается в момент открытия, а не готовится заранее вместе со страницей:
 * список магазинов и так тяжёлый, а считать связи для каждого из пяти магазинов ради
 * кнопки, которую нажимают раз в полгода, — впустую.
 *
 * Кнопки «Удалить» может не быть вовсе: если к магазину привязаны заказы, диалог
 * объясняет, почему удаление невозможно, и отправляет к «Отключить».
 */
export function DeleteSiteDialog({ siteId, siteName }: { siteId: string; siteName: string }) {
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<SiteDeletionImpact | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, start] = useTransition();

  async function openDialog() {
    setOpen(true);
    setLoading(true);
    setImpact(null);
    try {
      setImpact(await ownerGetSiteDeletionImpact(siteId));
    } finally {
      setLoading(false);
    }
  }

  function submit() {
    start(async () => {
      const res = await ownerDeleteSite(siteId);
      if (res?.error) {
        toast.error(res.error);
        return;
      }
      toast.success(res?.message ?? "Магазин удалён");
      setOpen(false);
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-red-600 hover:bg-red-50 hover:text-red-700"
        onClick={openDialog}
      >
        <Trash2 className="size-4" />
        Удалить сайт
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить магазин «{siteName}»?</DialogTitle>
          </DialogHeader>

          {loading && <p className="text-sm text-slate-500">Считаю, что будет затронуто…</p>}

          {!loading && !impact && (
            <p className="text-sm text-slate-500">Магазин не найден — возможно, он уже удалён.</p>
          )}

          {!loading && impact && (
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
                <div className="font-medium break-words text-slate-800">
                  {impact.name} <span className="text-slate-400">· {impact.shortName}</span>
                </div>
                <div className="mt-0.5 break-all text-slate-600">{impact.domain ?? "домен не задан"}</div>
                <div className="mt-1 text-xs text-slate-500">
                  {impact.platform} · {impact.connectionStatus}
                  {impact.neverConnected && " · подключение не завершено"}
                </div>
              </div>

              {impact.canDelete ? (
                <>
                  {impact.willDelete.length > 0 ? (
                    <div>
                      <div className="text-sm font-medium text-slate-800">Вместе с магазином будет удалено:</div>
                      <ul className="mt-1.5 space-y-0.5 text-sm text-slate-600">
                        {impact.willDelete.map((r) => (
                          <li key={r.label} className="flex items-baseline justify-between gap-3">
                            <span className="min-w-0 break-words">{r.label}</span>
                            <span className="shrink-0 tabular-nums text-slate-500">{r.count}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-600">
                      К магазину ничего не привязано: ни заказов, ни товаров, ни настроек. Удаление пройдёт полностью.
                    </p>
                  )}

                  {/* Единственное «красное» место во всём диалоге — сама необратимость. */}
                  <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    Действие необратимо. Восстановить магазин и его данные будет нельзя.
                  </p>

                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
                      Отмена
                    </Button>
                    <Button variant="destructive" disabled={pending} onClick={submit}>
                      {pending ? "Удаляю…" : "Удалить навсегда"}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {impact.blockers.map((b) => (
                    <p
                      key={b}
                      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
                    >
                      {b}
                    </p>
                  ))}
                  <div className="flex justify-end">
                    <Button variant="outline" onClick={() => setOpen(false)}>
                      Понятно
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
