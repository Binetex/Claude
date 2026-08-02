"use client";
/**
 * Таблица подтверждения доставки. Ничего не отмечено заранее и ничего не применяется
 * автоматически: владелец сам выбирает заказы, смотрит предпросмотр и подтверждает.
 *
 * Каждый заказ подтверждается СВОЕЙ суммой из его же записи Burq — общего значения тут
 * не существует. Котировка и фактическая стоимость помечены по-разному: котировка — это
 * оценка до доставки, и подтверждать её вслепую не стоит.
 */
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardBody } from "@/components/ui/Card";
import { formatCents } from "@/lib/cents";
import { cn } from "@/lib/cn";
import { applyBurqDelivery, previewBurqDelivery } from "../setupActions";
import type { BurqDeliveryCandidate } from "@/modules/finance/fix";

type Preview = { orders: number; totalCents: number; days: string[]; finalCount: number; quoteCount: number };

export function BurqDeliveryTable({ candidates }: { candidates: BurqDeliveryCandidate[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [comment, setComment] = useState("");
  const [previewing, startPreview] = useTransition();
  const [saving, startSave] = useTransition();

  const finalOnly = useMemo(() => candidates.filter((c) => c.burqSource === "FINAL"), [candidates]);

  function toggle(orderId: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
    setPreview(null);
  }

  function selectAllFinal() {
    setSelected(new Set(finalOnly.map((c) => c.orderId)));
    setPreview(null);
  }

  function runPreview() {
    startPreview(async () => {
      const res = await previewBurqDelivery([...selected]);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      setPreview(res.preview);
    });
  }

  function apply() {
    startSave(async () => {
      const res = await applyBurqDelivery([...selected], comment);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Готово");
      setSelected(new Set());
      setPreview(null);
    });
  }

  const th = "px-3 py-2 text-left text-[11px] font-medium tracking-wide text-slate-400 uppercase";
  const td = "px-3 py-2";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-500">
          Кандидатов: {candidates.length} · с фактической суммой: {finalOnly.length}
        </span>
        <Button variant="outline" size="sm" onClick={selectAllFinal} disabled={finalOnly.length === 0}>
          Отметить все с фактической суммой
        </Button>
        {selected.size > 0 && (
          <Button variant="ghost" size="sm" onClick={() => { setSelected(new Set()); setPreview(null); }}>
            Снять выделение
          </Button>
        )}
      </div>

      <Card>
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className={th}></th>
                  <th className={th}>Заказ</th>
                  <th className={th}>Дата</th>
                  <th className={th}>Магазин</th>
                  <th className={th}>Сумма Burq</th>
                  <th className={th}>Источник</th>
                  <th className={th}>Сейчас в заказе</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr
                    key={c.orderId}
                    className={cn("border-b border-slate-50 last:border-0", selected.has(c.orderId) && "bg-slate-50/70")}
                  >
                    <td className={td}>
                      <input
                        type="checkbox"
                        checked={selected.has(c.orderId)}
                        onChange={() => toggle(c.orderId)}
                        aria-label={`Выбрать ${c.orderNumber}`}
                      />
                    </td>
                    <td className={td}>
                      <Link href={`/dashboard/orders/${c.orderId}`} className="text-blue-600 hover:underline">
                        {c.orderNumber}
                      </Link>
                    </td>
                    <td className={`${td} tabular-nums text-slate-500`}>{c.deliveryDay}</td>
                    <td className={`${td} text-slate-500`}>{c.siteShortName}</td>
                    <td className={`${td} font-medium tabular-nums`}>{formatCents(c.burqCents)}</td>
                    <td className={td}>
                      {c.burqSource === "FINAL" ? (
                        <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">Факт</Badge>
                      ) : (
                        <Badge className="border-amber-200 bg-amber-50 text-amber-800">Котировка</Badge>
                      )}
                    </td>
                    <td className={`${td} tabular-nums text-slate-400`}>
                      {c.currentCents === 0 ? "не задана" : formatCents(c.currentCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      {selected.size > 0 && (
        <Card>
          <CardBody className="space-y-3">
            <div className="text-sm text-slate-600">Выбрано заказов: {selected.size}</div>

            {preview && (
              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3 text-xs">
                <div className="mb-1.5 font-medium text-slate-700">Что будет применено</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                  <div>
                    <div className="text-slate-400">Заказов</div>
                    <div className="tabular-nums text-slate-800">{preview.orders}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">Сумма доставки</div>
                    <div className="tabular-nums text-slate-800">{formatCents(preview.totalCents)}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">Факт / котировка</div>
                    <div className="tabular-nums text-slate-800">
                      {preview.finalCount} / {preview.quoteCount}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400">Дней к пересчёту</div>
                    <div className="tabular-nums text-slate-800">{preview.days.length}</div>
                  </div>
                </div>
                {preview.quoteCount > 0 && (
                  <div className="mt-2 text-amber-700">
                    Среди выбранных есть {preview.quoteCount} котировок — это оценка до доставки, а не фактическая
                    стоимость курьера.
                  </div>
                )}
                <div className="mt-2 text-slate-500">
                  На каждый заказ будет своя запись и своя строка аудита; снимки затронутых дней пересоберутся новой
                  ревизией. Начислений это не создаёт.
                </div>
              </div>
            )}

            <Input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Комментарий (необязательно)"
              className="text-sm"
            />

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={runPreview} disabled={previewing}>
                {previewing ? "Считаю…" : "Посмотреть"}
              </Button>
              <Button size="sm" onClick={apply} disabled={saving || !preview}>
                {saving ? "Применяю…" : `Подтвердить ${selected.size}`}
              </Button>
            </div>
            {!preview && (
              <div className="text-right text-xs text-slate-400">
                Подтверждение доступно после предпросмотра.
              </div>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
