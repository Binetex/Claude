"use client";
/**
 * Список заказов дня с ручной очередью.
 *
 * Плашки приезжают сюда уже отрисованными на сервере — этот компонент только держит ПОРЯДОК и
 * рисует колонку очереди рядом. Так вся тяжёлая разметка заказа остаётся серверной, а
 * мгновенной остаётся ровно та часть, которая обязана быть мгновенной.
 *
 * Почему порядок живёт здесь, а не на сервере: до этого каждое нажатие стрелки означало запись
 * в базу и пересборку всего экрана заказов — списка, блока закупки, значков переписки. Сама
 * запись занимала 24 мс, а ощущалось как «залипло», потому что к ней прибавлялись дорога до
 * сервера и полная перерисовка. Теперь плашка едет сразу, а на сервер уходит ИТОГ.
 *
 * Сохранение отложенное и целиком: через паузу после последнего нажатия отправляется весь
 * получившийся порядок. Не «сдвинь на шаг» — иначе два быстрых нажатия устраивали бы гонку и
 * база молча расходилась бы с экраном.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { saveDayQueueAction } from "./reorderActions";

/** Пауза после последнего нажатия. Короткая намеренно: всё, что не успело уйти, теряется при
 *  уходе со страницы, а полсекунды человеку не перегнать. */
const SAVE_DELAY_MS = 700;

type QueueItem = { id: string; desktop: React.ReactNode; mobile: React.ReactNode };
type SaveState = "idle" | "saving" | "saved" | "error";

export function OrderQueueList({ items, editable }: { items: QueueItem[]; editable: boolean }) {
  const [ids, setIds] = useState(() => items.map((i) => i.id));
  const [state, setState] = useState<SaveState>("idle");
  const pending = useRef<string[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Список следует за сервером: заказ мог сменить дату, появиться новый, уехать в другой
  // фильтр. Пересобираем порядок только когда пришёл ДРУГОЙ набор заказов, иначе собственная
  // перестановка стиралась бы на каждой перерисовке страницы.
  const fingerprint = items.map((i) => i.id).join(",");
  const [applied, setApplied] = useState(fingerprint);
  if (applied !== fingerprint) {
    setApplied(fingerprint);
    setIds(items.map((i) => i.id));
  }

  const flush = useCallback(async () => {
    const payload = pending.current;
    if (!payload) return;
    pending.current = null;
    setState("saving");
    try {
      const res = await saveDayQueueAction(payload);
      setState(res.error ? "error" : "saved");
    } catch {
      setState("error");
    }
  }, []);

  // Уход со страницы: дослать немедленно. Пауза короткая, но тыкнуть в заказ сразу после
  // последнего нажатия человек успевает, и молча потерять расстановку нельзя.
  useEffect(() => {
    const onHide = () => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    };
    // Обе ссылки именованные: на анонимной стрелке removeEventListener ничего не снимает, и
    // обработчик пережил бы сам список.
    const onVisibility = () => document.visibilityState === "hidden" && onHide();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      onHide();
    };
  }, [flush]);

  const move = (id: string, direction: "up" | "down") => {
    setIds((prev) => {
      const from = prev.indexOf(id);
      const to = direction === "up" ? from - 1 : from + 1;
      if (from === -1 || to < 0 || to >= prev.length) return prev; // край списка — не ошибка
      const next = [...prev];
      [next[from], next[to]] = [next[to]!, next[from]!];
      pending.current = next;
      setState("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
      return next;
    });
  };

  const byId = new Map(items.map((i) => [i.id, i]));
  const ordered = ids.map((id) => byId.get(id)).filter((i): i is QueueItem => !!i);

  const row = (item: QueueItem, index: number, node: React.ReactNode) => (
    <div key={item.id} className="flex items-start gap-1.5">
      <QueueColumn
        number={index + 1}
        editable={editable}
        first={index === 0}
        last={index === ordered.length - 1}
        onUp={() => move(item.id, "up")}
        onDown={() => move(item.id, "down")}
      />
      <div className="min-w-0 flex-1">{node}</div>
    </div>
  );

  return (
    <>
      {editable && <SaveHint state={state} />}
      <div className="hidden space-y-3 md:block">{ordered.map((i, n) => row(i, n, i.desktop))}</div>
      <div className="space-y-2.5 md:hidden">{ordered.map((i, n) => row(i, n, i.mobile))}</div>
    </>
  );
}

/**
 * Колонка очереди: стрелка, номер, стрелка — одним узким столбиком.
 *
 * Стрелки над и под номером, а не сбоку: столбик шириной в 22 пикселя вместо сорока с лишним,
 * и на телефоне эти двадцать пикселей забирает себе адрес получателя, а не пустое место.
 */
function QueueColumn({
  number,
  editable,
  first,
  last,
  onUp,
  onDown,
}: {
  number: number;
  editable: boolean;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  const btn = "flex h-4 w-[22px] items-center justify-center rounded text-[9px] leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-25 disabled:hover:bg-transparent";
  return (
    <div className="flex w-[22px] shrink-0 flex-col items-center pt-3">
      {editable && (
        <button type="button" className={btn} aria-label="Делать раньше" disabled={first} onClick={onUp}>
          ▲
        </button>
      )}
      <span className="text-[13px] font-semibold tabular-nums text-slate-400">{number}</span>
      {editable && (
        <button type="button" className={btn} aria-label="Делать позже" disabled={last} onClick={onDown}>
          ▼
        </button>
      )}
    </div>
  );
}

/** Состояние сохранения: без него десять секунд непонятно, записалось или нет. */
function SaveHint({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  const text =
    state === "saving" ? "Сохраняю порядок…"
    : state === "saved" ? "Порядок сохранён"
    : "Не удалось сохранить порядок — обновите страницу.";
  const cls = state === "error" ? "text-rose-600" : "text-slate-400";
  return <div className={`mb-1 text-[11px] ${cls}`}>{text}</div>;
}
