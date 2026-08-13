"use client";
import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { ownerListEmailFactoryDomains, ownerSetSiteEmailFactoryDomain } from "./emailFactoryActions";

/**
 * Домен Email Factory ЭТОГО магазина — с него уходит ручная переписка с клиентом из карточки
 * заказа. Список доменов спрашивается у Email Factory при открытии: подключают их там, и наша
 * копия рано или поздно разошлась бы с правдой.
 *
 * Это НЕ настройки Brevo, который живёт в соседнем блоке. Каналы независимы: Brevo шлёт
 * автоматические письма по событиям заказа, Email Factory — только переписку руками.
 */
export function SiteEmailFactoryPanel({ siteId, current }: { siteId: string; current: string | null }) {
  const router = useRouter();
  const [domains, setDomains] = useState<{ domain: string; email: string }[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [value, setValue] = useState(current ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    ownerListEmailFactoryDomains().then((r) => {
      if (r.error) setLoadError(r.error);
      else setDomains(r.domains ?? []);
    });
  }, []);

  function save() {
    setMsg(null);
    start(async () => {
      const r = await ownerSetSiteEmailFactoryDomain(siteId, value);
      setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? "Готово" });
      router.refresh();
    });
  }

  const chosen = domains?.find((d) => d.domain === value);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Email Factory — переписка с клиентом</CardTitle>
        <span
          className={`rounded border px-1.5 py-px text-[10px] font-medium ${
            current ? "border-emerald-200 bg-emerald-100 text-emerald-800" : "border-slate-200 bg-slate-100 text-slate-600"
          }`}
        >
          {current ? "домен выбран" : "домен не выбран"}
        </span>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <p className="text-xs text-slate-500">
          С этого домена уходят письма, которые сотрудник пишет клиенту из карточки заказа. К рассылкам Brevo отношения не имеет —
          это разные каналы.
        </p>

        {loadError && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            Не удалось получить список доменов: {loadError.replace(/\.$/, "")}. Токен задаётся на странице «Сайты».
          </div>
        )}

        {domains && domains.length === 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            В Email Factory нет ни одного подтверждённого домена — сначала подключите домен там.
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[260px] flex-1 space-y-1">
            <label className="text-xs text-slate-400">Домен отправки</label>
            <select
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setMsg(null);
              }}
              disabled={!domains || domains.length === 0}
              className="w-full rounded border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-50"
            >
              <option value="">— не выбран —</option>
              {domains?.map((d) => (
                <option key={d.domain} value={d.domain}>
                  {d.domain}
                </option>
              ))}
              {/* Домен мог быть выбран раньше и с тех пор отключён в Email Factory. Показываем его
                  отдельной строкой, иначе список молча сбросил бы настройку на «не выбран». */}
              {current && !domains?.some((d) => d.domain === current) && (
                <option value={current}>{current} — больше не подтверждён</option>
              )}
            </select>
          </div>
          <Button type="button" size="sm" disabled={pending || value === (current ?? "")} onClick={save}>
            Сохранить
          </Button>
        </div>

        {chosen && <p className="text-[11px] text-slate-400">Письма будут уходить с адреса {chosen.email}.</p>}
        {!current && domains && domains.length === 1 && (
          <p className="text-[11px] text-slate-400">
            Домен в аккаунте один, поэтому он используется и без выбора. Задать явно стоит, когда доменов станет несколько.
          </p>
        )}
        {msg && <div className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</div>}
      </CardBody>
    </Card>
  );
}
