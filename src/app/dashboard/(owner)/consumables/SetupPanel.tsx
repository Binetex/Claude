"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/Card";
import { ownerCreateDefaultConsumables } from "./actions";

/**
 * Пустой справочник — предлагаем создать ровно те колонки, что были в таблице владельца.
 * Магазин со своей упаковкой спрашиваем сразу: от него зависят записки и брендированный конверт.
 */
export function SetupPanel({ sites }: { sites: { id: string; label: string }[] }) {
  const [siteId, setSiteId] = useState(sites.find((s) => /theflow/i.test(s.label))?.id ?? sites[0]?.id ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <Card>
      <CardBody className="space-y-3">
        <p className="text-sm text-slate-600">
          Справочник пуст. Создам те же колонки, что были в вашей таблице: коробки, конверты, донышки,
          две записки Care Guide и вазы по типам.
        </p>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-slate-500">Магазин со своей упаковкой (записки и брендированный конверт)</span>
          <select
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            className="w-64 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          disabled={pending || !siteId}
          onClick={() => start(async () => {
            const r = await ownerCreateDefaultConsumables(siteId);
            setMsg(r.error ?? r.message ?? "Готово");
          })}
        >
          {pending ? "Создаём…" : "Создать стандартный набор"}
        </Button>
        {msg && <div className="text-xs text-slate-600">{msg}</div>}
      </CardBody>
    </Card>
  );
}
