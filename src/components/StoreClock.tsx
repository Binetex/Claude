"use client";
/**
 * Часы Лос-Анджелеса в шапке.
 *
 * Магазины работают по LA, а сотрудники сидят в других поясах, и половина ошибок с доставкой
 * начиналась с того, что человек смотрел на свои часы. Здесь всегда время магазина, и подпись
 * «LA Time» рядом, чтобы это не приходилось помнить.
 *
 * Считается на клиенте и тикает: время, отрисованное сервером один раз, к обеду отстало бы на
 * часы. До первого тика показываем присланное сервером значение, иначе в разметке на секунду
 * возникала бы дыра.
 */
import { useEffect, useState } from "react";
import { DEFAULT_STORE_TZ } from "@/lib/tz";

const FMT = new Intl.DateTimeFormat("ru-RU", { timeZone: DEFAULT_STORE_TZ, hour: "2-digit", minute: "2-digit" });

export function StoreClock({ initial }: { initial: string }) {
  const [time, setTime] = useState(initial);
  useEffect(() => {
    const tick = () => setTime(FMT.format(new Date()));
    tick();
    // Раз в 15 секунд: минута на экране не должна опаздывать больше чем на четверть минуты,
    // а секундный таймер ради этого будить браузер незачем.
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="hidden text-right leading-tight sm:block">
      <div className="text-sm font-medium tabular-nums text-slate-700">{time}</div>
      <div className="text-[11px] text-slate-400">LA Time</div>
    </div>
  );
}
