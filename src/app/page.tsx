import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { homePathFor } from "@/lib/rbac";

// Публичный лендинг. Не гейтится авторизацией — рендерится всем.
// Авторизованный пользователь получает CTA прямо в панель вместо повторного логина.
export default async function Home() {
  const user = await getCurrentUser();
  const ctaHref = user ? homePathFor(user.role) : "/login";
  const ctaLabel = user ? "Перейти в панель" : "Войти";

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
        <div className="text-lg font-bold text-slate-800">🌸 Floremart</div>
        <Link
          href={ctaHref}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-900"
        >
          {ctaLabel}
        </Link>
      </header>

      <main className="mx-auto flex max-w-3xl flex-1 flex-col items-center justify-center px-6 py-24 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
          Единый дашборд для флористических магазинов
        </h1>
        <p className="mt-6 max-w-xl text-lg text-slate-600">
          Floremart объединяет заказы с ваших сайтов на WooCommerce и Shopify в одном месте —
          с автоматическим распределением между флористами, прозрачными ценами и ролями для
          команды и колл-центра.
        </p>
        <Link
          href={ctaHref}
          className="mt-10 rounded-lg bg-slate-800 px-6 py-3 text-base font-medium text-white hover:bg-slate-900"
        >
          {ctaLabel}
        </Link>
      </main>

      <footer className="border-t border-slate-200 px-6 py-6 text-center text-sm text-slate-400">
        © {new Date().getFullYear()} Floremart
      </footer>
    </div>
  );
}
