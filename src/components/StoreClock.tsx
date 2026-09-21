"use client";
/**
 * Часы Лос-Анджелеса под именем в шапке, на месте бывшей подписи роли.
 *
 * Роль человек и так знает — он под ней сидит, — а вот часы магазина ему нужны постоянно:
 * сотрудники работают из других поясов, и половина ошибок с доставкой начиналась с того, что
 * смотрели на свои часы. Поэтому строка одна и занята временем, а не должностью.
 *
 * Считается на клиенте и тикает: время, отрисованное сервером один раз, к обеду отстало бы на
 * часы. До первого тика показываем присланное сервером значение, иначе в разметке на миг
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
    <div className="text-[11px] text-slate-500">
      <span className="font-medium tabular-nums text-slate-600">{time}</span> <span className="text-slate-400">LA Time</span>
    </div>
  );
}
