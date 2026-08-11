import { requiredScopesText } from "@/integrations/shopify/customApp/scopes";
import { CopyScopesButton } from "./CopyScopesButton";

/**
 * Пошаговая инструкция владельцу. ВАЖНО: с 01.01.2026 admin «Develop apps» закрыт для новых
 * приложений — custom app создаётся в Dev Dashboard, а магазин должен быть в той же организации
 * (иначе client_credentials недоступен).
 *
 * Шаги свёрнуты по умолчанию: подключение нового магазина делают раз в несколько месяцев, а
 * полэкрана текста висели над формой постоянно. Свёртка нативная (`details`) — компонент
 * остаётся серверным, без состояния и без клиентского JS.
 *
 * Строка scopes НЕ прячется: её копируют в Shopify прямо во время заполнения формы, и лишний
 * клик за ней каждый раз бессмысленен.
 */
export function ConnectionInstructions() {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
      <details className="group">
        <summary className="cursor-pointer list-none font-semibold text-slate-700 marker:content-none">
          <span className="mr-1 inline-block transition-transform group-open:rotate-90">▶</span>
          Как создать Custom App для магазина
        </summary>
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
          <li>Откройте Shopify <b>Dev Dashboard</b> организации магазина (admin «Develop apps» с 2026 закрыт).</li>
          <li>Создайте приложение (Create app) и добавьте магазин в эту же организацию (Dev stores / организация).</li>
          <li>Укажите обязательные scopes (кнопка ниже) и активируйте версию приложения.</li>
          <li>Установите приложение в этот магазин.</li>
          <li>Скопируйте <b>Client ID</b> и <b>Client Secret</b>.</li>
          <li>Вставьте их во Floremart ниже и нажмите «Проверить подключение».</li>
        </ol>
        <p className="mt-2 text-xs text-amber-700">
          ⚠️ Для каждого магазина создаётся ОТДЕЛЬНОЕ приложение. Не используйте одни и те же credentials
          для нескольких магазинов. client_credentials работает только если приложение и магазин — в одной
          Shopify-организации.
        </p>
      </details>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="rounded bg-white px-2 py-1 text-xs break-all text-slate-700">{requiredScopesText()}</code>
        <CopyScopesButton />
      </div>
    </div>
  );
}
