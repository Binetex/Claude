"use client";
import { useEffect } from "react";
import { ErrorState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";

/**
 * Переиспользуемый UI для route-level error boundary (Next.js `error.tsx`).
 * Показывает дружелюбное сообщение вместо дефолтного оверлея и даёт кнопку повтора
 * (`reset()` перерисовывает сегмент). Технические детали ошибки не показываем пользователю —
 * только логируем в консоль (в проде подключить сюда отправку в мониторинг).
 */
export function RouteError({
  error,
  reset,
  title = "Не удалось загрузить раздел",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}) {
  useEffect(() => {
    // Логируем для диагностики; PII в сообщение ошибки не попадает (см. правила логирования).
    console.error("[route-error]", error.digest ?? "", error.message);
  }, [error]);

  return (
    <div className="p-6">
      <ErrorState
        title={title}
        description="Попробуйте обновить. Если ошибка повторяется — сообщите администратору."
        action={
          <Button variant="outline" size="sm" onClick={reset}>
            Повторить
          </Button>
        }
      />
    </div>
  );
}
