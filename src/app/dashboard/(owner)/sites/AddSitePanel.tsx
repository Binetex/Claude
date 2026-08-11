"use client";
import { useState } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { SiteConnectPanel } from "./SiteConnectPanel";

/**
 * Подключение нового магазина спрятано за кнопкой. Форма с инструкцией и переключателями
 * платформ занимает целый экран, а нужна раз в несколько месяцев — на странице, куда заходят
 * смотреть существующие магазины, она была самым крупным объектом.
 */
export function AddSitePanel() {
  const [open, setOpen] = useState(false);

  // Свёрнутое состояние — одна кнопка, прижатая вправо: строка не должна выглядеть как раздел.
  if (!open) {
    return (
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          + Подключить магазин
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-700">Подключить новый магазин</div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Свернуть</Button>
        </div>
        <SiteConnectPanel />
      </CardBody>
    </Card>
  );
}
