"use client";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { MessageSquare, Tag, Link2 } from "lucide-react";
import { TOPIC_UI_ORDER, TOPIC_LABEL, type TopicKey } from "@/integrations/quo/otherMessages";
import { setThreadTopicAction, sendThreadSmsAction, linkThreadAction } from "./actions";

const SMS_MAX = 1600;
const newKey = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** Готовый ответ на пропущенный звонок — владелец и так шлёт его руками из приложения QUO. */
const QUICK_REPLY = "Hey! Sorry we missed you. Do you need help with an order, pickup or delivery?";

export type ThreadActionsProps = {
  phone: string;
  pn: string;
  siteId: string | null;
  storeCanSend: boolean;
  storeName: string;
  topic: TopicKey;
  topicIsManual: boolean;
  suggestions: { orderId: string; orderNumber: string; role: "CUSTOMER" | "RECIPIENT" }[];
};

export function ThreadActions(props: ThreadActionsProps) {
  return (
    <div className="space-y-3">
      <TopicCard {...props} />
      <ReplyCard {...props} />
      <LinkCard {...props} />
    </div>
  );
}

function TopicCard({ phone, pn, topic, topicIsManual }: ThreadActionsProps) {
  const [state, action, pending] = useActionState(setThreadTopicAction, null);
  return (
    <Card>
      <CardHeader className="py-2.5"><CardTitle icon={Tag}>Категория</CardTitle></CardHeader>
      <CardBody className="space-y-2">
        <p className="text-xs text-slate-500">
          {topicIsManual
            ? "Категорию поставили вручную — правило её больше не трогает."
            : "Категорию определило правило по тексту переписки. Нажмите нужную, чтобы закрепить свою."}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {TOPIC_UI_ORDER.map((k) => (
            <form key={k} action={action}>
              <input type="hidden" name="phone" value={phone} />
              <input type="hidden" name="pn" value={pn} />
              <input type="hidden" name="topic" value={k} />
              <Button type="submit" size="sm" variant={k === topic ? "default" : "outline"} disabled={pending}>
                {TOPIC_LABEL[k]}
              </Button>
            </form>
          ))}
          {topicIsManual && (
            <form action={action}>
              <input type="hidden" name="phone" value={phone} />
              <input type="hidden" name="pn" value={pn} />
              <input type="hidden" name="topic" value="" />
              <Button type="submit" size="sm" variant="ghost" disabled={pending}>Вернуть правилу</Button>
            </form>
          )}
        </div>
        {state?.error && <div className="text-xs text-red-600">{state.error}</div>}
      </CardBody>
    </Card>
  );
}

function ReplyCard({ phone, pn, siteId, storeCanSend, storeName }: ThreadActionsProps) {
  const [text, setText] = useState("");
  const [idem, setIdem] = useState<string>(newKey);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok?: boolean; error?: string } | null>(null);

  if (!siteId) {
    return (
      <Card>
        <CardHeader className="py-2.5"><CardTitle icon={MessageSquare}>Ответить</CardTitle></CardHeader>
        <CardBody>
          <p className="text-xs text-slate-500">
            Этот QUO-номер не привязан ни к одному магазину, поэтому отправить ответ из дашборда нельзя.
            Привяжите номер магазину в разделе «Магазины» — и отправка появится.
          </p>
        </CardBody>
      </Card>
    );
  }

  const disabled = pending || !text.trim() || !storeCanSend;

  // Ровно тот же порядок, что в карточке заказа (OrderCommunications.tsx): собственный submit,
  // ключ идемпотентности одноразовый и меняется ТАКЖЕ после ошибки — сервер уже записал попытку
  // под этим ключом, и повтор с ним никогда не дошёл бы до QUO. Двойной клик закрыт `disabled`.
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    setPending(true);
    setResult(null);
    const fd = new FormData();
    // Магазин сервер определяет сам по QUO-номеру переписки — из браузера он не принимается.
    fd.set("pn", pn);
    fd.set("phone", phone);
    fd.set("text", text);
    fd.set("idempotencyKey", idem);
    try {
      const res = await sendThreadSmsAction(null, fd);
      setResult(res);
      if (res?.ok) setText("");
      setIdem(newKey());
    } catch {
      setResult({ error: "Не удалось отправить. Попробуйте ещё раз." });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="py-2.5"><CardTitle icon={MessageSquare}>Ответить · {storeName}</CardTitle></CardHeader>
      <CardBody className="space-y-2">
        {!storeCanSend && <p className="text-xs text-amber-700">У магазина не включён QUO — отправка недоступна.</p>}
        <form onSubmit={onSubmit} className="space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={pending}
            maxLength={SMS_MAX}
            rows={3}
            placeholder="Text in English — this goes straight to the customer"
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={disabled}>
              {pending ? "Отправляем…" : "Отправить SMS"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={pending || !storeCanSend} onClick={() => setText(QUICK_REPLY)}>
              Ответ на пропущенный
            </Button>
            <span className="text-[11px] text-slate-400">{text.length}/{SMS_MAX} · только по-английски</span>
          </div>
        </form>
        {result?.error && <div className="text-xs text-red-600">{result.error}</div>}
        {result?.ok && <div className="text-xs text-emerald-700">Отправлено.</div>}
      </CardBody>
    </Card>
  );
}

function LinkCard({ phone, pn, suggestions }: ThreadActionsProps) {
  const [state, action, pending] = useActionState(linkThreadAction, null);
  const [manual, setManual] = useState("");

  return (
    <Card>
      <CardHeader className="py-2.5"><CardTitle icon={Link2}>Привязать к заказу</CardTitle></CardHeader>
      <CardBody className="space-y-2">
        <p className="text-xs text-slate-500">Переписка уедет в заказ целиком и пропадёт из этого раздела.</p>
        {suggestions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <form key={s.orderId} action={action}>
                <input type="hidden" name="phone" value={phone} />
                <input type="hidden" name="pn" value={pn} />
                <input type="hidden" name="orderId" value={s.orderId} />
                <Button type="submit" size="sm" variant="outline" disabled={pending}>
                  #{s.orderNumber} · {s.role === "CUSTOMER" ? "покупатель" : "получатель"}
                </Button>
              </form>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500">Подходящих заказов по этому номеру не нашлось.</p>
        )}
        <form action={action} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="phone" value={phone} />
          <input type="hidden" name="pn" value={pn} />
          <input
            name="orderNumber"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="номер заказа"
            className="w-40 rounded border border-slate-300 px-2 py-1 text-sm"
          />
          <Button type="submit" size="sm" variant="outline" disabled={pending || !manual.trim()}>Привязать</Button>
        </form>
        {state?.error && <div className="text-xs text-red-600">{state.error}</div>}
        {state?.ok && <div className="text-xs text-emerald-700">Привязано.</div>}
      </CardBody>
    </Card>
  );
}
