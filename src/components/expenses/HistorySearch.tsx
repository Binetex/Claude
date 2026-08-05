"use client";
/**
 * Поиск по истории расходов.
 *
 * Состояние в URL, как и месяц в сводке: ссылку на «все расходы по OpenAI» можно сохранить,
 * а «назад» работает как ожидается.
 *
 * Отправка по Enter и по кнопке, а не на каждый символ: запрос идёт на сервер, и дёргать
 * его на каждую букву значит гонять список туда-сюда без пользы.
 */
import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function HistorySearch() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [value, setValue] = useState(sp.get("q") ?? "");

  const submit = (next: string) => {
    const params = new URLSearchParams(sp.toString());
    if (next.trim()) params.set("q", next.trim());
    else params.delete("q");
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="relative w-full max-w-72">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" />
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit(value);
          if (e.key === "Escape") {
            setValue("");
            submit("");
          }
        }}
        placeholder="Найти: OpenAI, домен, реклама…"
        aria-label="Поиск по расходам"
        className="pr-8 pl-8"
      />
      {value && (
        <Button
          variant="ghost"
          size="iconSm"
          aria-label="Очистить поиск"
          className="absolute top-1/2 right-1 -translate-y-1/2 text-slate-400"
          onClick={() => {
            setValue("");
            submit("");
          }}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}
