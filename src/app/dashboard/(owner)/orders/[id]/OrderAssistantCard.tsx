import { Bot } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { AssistantOrderToggle } from "./AssistantOrderToggle";

/**
 * Что ассистент сделал с входящими по этому заказу. Видит ТОЛЬКО владелец.
 *
 * Нужен ради сухого прогона: пока ассистент никому не отвечает, единственный способ понять,
 * годится ли он, — прочитать его черновики и причины молчания. Поэтому здесь показывается и то,
 * чего клиент никогда не увидит: полный запрос к модели и её сырой ответ.
 */
export type AssistantTurn = {
  id: string;
  status: string;
  source: string;
  intent: string | null;
  important: boolean;
  needsHuman: boolean;
  replyText: string | null;
  skipReason: string | null;
  promptText: string | null;
  responseText: string | null;
  modelName: string | null;
  latencyMs: number | null;
  createdAt: string;
  incomingText: string | null;
};

/** Человеческие подписи причин молчания: коды в интерфейсе читать невозможно. */
const SKIP_LABELS: Record<string, string> = {
  order_disabled: "ассистент выключен на этом заказе",
  assistant_off: "ассистент выключен у магазина",
  order_closed: "заказ отменён",
  delivered_long_ago: "доставлен больше трёх дней назад",
  small_talk: "клиент просто поблагодарил",
  empty_text: "пустое сообщение",
  recent_automated_message: "только что ушло автоматическое сообщение",
  daily_cap: "исчерпан дневной потолок ответов",
  order_cap: "исчерпан потолок ответов на заказ",
  model_not_configured: "модель не подключена",
};

function skipLabel(reason: string | null): string {
  if (!reason) return "причина не записана";
  if (reason.startsWith("model_")) return `модель недоступна (${reason.replace("model_", "")})`;
  return SKIP_LABELS[reason] ?? reason;
}

/**
 * Карточка есть, только когда ассистент у магазина включён или по заказу уже есть разборы:
 * у магазина без ассистента галочка «без ИИ» ничего не выключает.
 */
export function OrderAssistantCard({
  orderId, turns, dryRun, enabled, disabledOnOrder,
}: { orderId: string; turns: AssistantTurn[]; dryRun: boolean; enabled: boolean; disabledOnOrder: boolean }) {
  if (turns.length === 0 && !enabled) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Bot className="size-4 text-slate-400" />
          Ассистент
          {dryRun && enabled && (
            <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-px text-[11px] font-normal text-amber-700">
              сухой прогон — клиенту не уходит ничего
            </span>
          )}
          <span className="ml-auto">
            <AssistantOrderToggle orderId={orderId} disabled={disabledOnOrder} />
          </span>
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        {turns.length === 0 && <p className="text-sm text-slate-500">Входящих по этому заказу ассистент ещё не разбирал.</p>}
        {turns.map((t) => (
          <div key={t.id} className="rounded-lg border border-slate-200 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
              <span className="font-mono">{new Date(t.createdAt).toLocaleString("ru-RU")}</span>
              {t.intent && <span className="rounded bg-slate-100 px-1.5 py-px">{t.intent}</span>}
              {t.important && <span className="rounded bg-red-50 px-1.5 py-px text-red-700">важное</span>}
              {t.needsHuman && t.status !== "SKIPPED" && <span className="rounded bg-amber-50 px-1.5 py-px text-amber-700">нужен человек</span>}
              {t.modelName && <span>{t.modelName}{t.latencyMs != null ? ` · ${(t.latencyMs / 1000).toFixed(1)} с` : ""}</span>}
            </div>

            {t.incomingText && (
              <p className="mt-1.5 text-sm text-slate-600">
                <span className="text-slate-400">Клиент:</span> {t.incomingText}
              </p>
            )}

            {t.status === "SKIPPED" ? (
              <p className="mt-1 text-sm text-slate-500">Не отвечаем: {skipLabel(t.skipReason)}</p>
            ) : t.status === "FAILED" ? (
              <p className="mt-1 text-sm text-red-600">Ответа нет: {skipLabel(t.skipReason)}</p>
            ) : t.replyText ? (
              <p className="mt-1 rounded-md bg-slate-50 px-2.5 py-2 text-sm text-slate-800">{t.replyText}</p>
            ) : (
              <p className="mt-1 text-sm text-slate-500">Текста нет — нужен человек.</p>
            )}

            {/* Полный запрос и сырой ответ: без них на вопрос «почему он так ответил» нечем
                отвечать, кроме догадок. Свёрнуто — читают их редко. */}
            {(t.promptText || t.responseText) && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-600">
                  Что спрашивали у модели
                </summary>
                {t.promptText && (
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600">
                    {t.promptText}
                  </pre>
                )}
                {t.responseText && (
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600">
                    {t.responseText}
                  </pre>
                )}
              </details>
            )}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
