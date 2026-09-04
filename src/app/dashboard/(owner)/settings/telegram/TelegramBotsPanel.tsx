"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { saveBot, removeBotToken, verifyBotAction, toggleBot, toggleGlobal, enableBotRepliesAction, disableBotRepliesAction } from "./actions";
import type { BotRow, BotPurpose } from "@/integrations/telegram/bots";
import type { RepliesStatus } from "@/integrations/telegram/replies";
import type { VerifyResult } from "@/integrations/telegram/verify";

type Florist = { id: string; name: string };

/** Одна карточка бота: владельца или флориста. Флорист может ещё не иметь бота — тогда bot=null. */
function BotCard({
  title,
  subtitle,
  purpose,
  floristId,
  bot,
  replies,
  onDone,
}: {
  title: string;
  subtitle: string;
  purpose: BotPurpose;
  floristId: string | null;
  bot: BotRow | null;
  replies: RepliesStatus | null;
  onDone: () => void;
}) {
  const [pending, start] = useTransition();
  // Поле токена ВСЕГДА пустое: существующий токен наружу не отдаётся.
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState(bot?.chatId ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const verified = !!bot?.verifiedAt;

  function run(fn: () => Promise<{ ok?: true; message?: string; error?: string }>) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? "Готово" });
      onDone();
    });
  }

  return (
    <div className="space-y-2 border-b border-slate-100 py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-800">{title}</span>
        <span className="text-xs text-slate-400">{subtitle}</span>
        {bot?.tokenConfigured ? (
          <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[11px] text-emerald-700">Configured</span>
        ) : (
          <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] text-slate-500">Не настроен</span>
        )}
        {verified && (
          <span className="rounded border border-sky-200 bg-sky-50 px-1.5 py-px text-[11px] text-sky-700">
            Проверен{bot?.botUsername ? ` · @${bot.botUsername}` : ""}
          </span>
        )}
        {bot?.tokenConfigured && (
          replies?.enabled ? (
            <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[11px] text-emerald-700">Приём ответов включён</span>
          ) : (
            <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-px text-[11px] text-amber-800">Приём ответов выключен</span>
          )
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          type="password"
          autoComplete="new-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={bot?.tokenConfigured ? "Настроен — пусто = не менять" : "Bot Token"}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <input
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          placeholder="Chat ID (например 123456789)"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => run(() => saveBot({ purpose, floristId, label: title, token, chatId }))}>
          Сохранить
        </Button>
        {bot && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !bot.tokenConfigured}
            onClick={() => {
              setMsg(null);
              setVerify(null);
              start(async () => {
                const r = await verifyBotAction(bot.id);
                if ("error" in r) setMsg({ ok: false, text: r.error });
                else {
                  setVerify(r.result);
                  setMsg({ ok: r.result.ok, text: r.result.ok ? "Проверка пройдена" : "Проверка не пройдена" });
                }
                onDone();
              });
            }}
          >
            Проверить
          </Button>
        )}
        {bot && (
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={bot.enabled}
              disabled={pending || (!verified && !bot.enabled)}
              onChange={(e) => run(() => toggleBot(bot.id, e.target.checked))}
            />
            {bot.enabled ? "включён" : "выключен"}
          </label>
        )}
        {bot?.tokenConfigured && (
          confirmDelete ? (
            <>
              <Button size="sm" variant="destructive" disabled={pending} onClick={() => { setConfirmDelete(false); run(() => removeBotToken(bot.id)); }}>
                Точно удалить?
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Отмена</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmDelete(true)}>Удалить токен</Button>
          )
        )}
        {msg && <span className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</span>}
      </div>

      {/* Приём ответов — отдельной строкой с состоянием: кнопка без состояния читалась как
          «нажал — и что?». Правда о вебхуке спрашивается у Telegram при каждой загрузке. */}
      {bot?.tokenConfigured && (
        <div className={`flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs ${replies?.enabled ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/60"}`}>
          <span className={replies?.enabled ? "font-medium text-emerald-800" : "font-medium text-amber-900"}>
            {replies?.enabled ? "✓ Приём ответов включён" : "○ Приём ответов выключен"}
          </span>
          <span className="text-slate-600">
            {replies?.enabled
              ? "— бот принимает кнопку «Отправить» и ваши ответы реплаем по черновикам ассистента."
              : `— черновики ассистента приходят, но кнопка «Отправить» и ответы реплаем не работают${replies?.detail ? ` (${replies.detail})` : ""}.`}
          </span>
          {replies?.lastError && <span className="text-red-600">Последняя ошибка Telegram: {replies.lastError}</span>}
          <Button
            type="button"
            size="sm"
            variant={replies?.enabled ? "ghost" : "default"}
            className="ml-auto"
            disabled={pending || (!replies?.enabled && !bot.enabled)}
            title={!replies?.enabled && !bot.enabled ? "Сначала включите бота" : undefined}
            onClick={() => run(() => (replies?.enabled ? disableBotRepliesAction(bot.id) : enableBotRepliesAction(bot.id)))}
          >
            {replies?.enabled ? "Выключить приём" : "Включить приём ответов"}
          </Button>
        </div>
      )}

      {(verify || bot?.lastErrorSafe) && (
        <div className="space-y-0.5 rounded-md bg-slate-50 p-2">
          {verify?.steps.map((s) => (
            <div key={s.step} className="text-xs">
              <span className={s.ok ? "text-emerald-600" : "text-red-600"}>{s.ok ? "✓" : "✕"}</span>{" "}
              <span className="text-slate-600">{s.step === "getMe" ? "Бот и токен" : "Сообщение в чат"}: {s.detail}</span>
            </div>
          ))}
          {!verify && bot?.lastErrorSafe && <div className="text-xs text-red-600">{bot.lastErrorSafe}</div>}
        </div>
      )}
    </div>
  );
}

export function TelegramBotsPanel({
  global,
  bots,
  replies,
  florists,
}: {
  global: { enabled: boolean; cryptoConfigured: boolean };
  bots: BotRow[];
  replies: Record<string, RepliesStatus>;
  florists: Florist[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const refresh = () => router.refresh();

  const ownerBot = bots.find((b) => b.purpose === "OWNER") ?? null;
  const serviceBot = bots.find((b) => b.purpose === "CUSTOMER_SERVICE") ?? null;
  const botByFlorist = new Map(bots.filter((b) => b.floristId).map((b) => [b.floristId!, b]));

  return (
    <div className="space-y-4">
      {!global.cryptoConfigured && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          На сервере не задан ключ шифрования credentials — сохранить токен не получится.
        </div>
      )}

      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Общий выключатель</h2>
            <p className="text-xs text-slate-500">Гасит всю рассылку разом, настройки отдельных ботов не трогает.</p>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={global.enabled}
              disabled={pending}
              onChange={(e) => start(async () => { await toggleGlobal(e.target.checked); refresh(); })}
            />
            {global.enabled ? "Уведомления включены" : "Уведомления выключены"}
          </label>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          <div className="px-4 pt-3">
            <h2 className="text-sm font-semibold text-slate-800">Бот владельца</h2>
            <p className="text-xs text-slate-500">Новые заказы, проблемы с оплатой и доставкой.</p>
          </div>
          <div className="px-4 pb-2">
            <BotCard title="Владелец" subtitle="" purpose="OWNER" floristId={null} bot={ownerBot} replies={ownerBot ? replies[ownerBot.id] ?? null : null} onDone={refresh} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          <div className="px-4 pt-3">
            <h2 className="text-sm font-semibold text-slate-800">Бот колл-центра</h2>
            <p className="text-xs text-slate-500">
              Задачи оператору: например, попросить у клиента отзыв по помеченному заказу.
              Без настроенного бота такие задачи просто не отправляются.
            </p>
          </div>
          <div className="px-4 pb-2">
            <BotCard title="Колл-центр" subtitle="" purpose="CUSTOMER_SERVICE" floristId={null} bot={serviceBot} replies={serviceBot ? replies[serviceBot.id] ?? null : null} onDone={refresh} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          <div className="px-4 pt-3">
            <h2 className="text-sm font-semibold text-slate-800">Боты флористов</h2>
            <p className="text-xs text-slate-500">
              У каждого флориста свой бот и свой чат. Chat ID личного чата флорист узнаёт, написав своему боту.
              Флорист без настроенного бота уведомлений не получает.
            </p>
          </div>
          <div className="px-4 pb-2">
            {florists.length === 0 && <p className="py-3 text-xs text-slate-400">Активных флористов нет.</p>}
            {florists.map((f) => (
              <BotCard
                key={f.id}
                title={f.name}
                subtitle="флорист"
                purpose="FLORIST"
                floristId={f.id}
                bot={botByFlorist.get(f.id) ?? null}
                replies={botByFlorist.get(f.id) ? replies[botByFlorist.get(f.id)!.id] ?? null : null}
                onDone={refresh}
              />
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
