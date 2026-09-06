import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { homePathFor } from "@/lib/rbac";

/**
 * Публичный лендинг. Не гейтится авторизацией — рендерится всем.
 * Авторизованный пользователь получает CTA прямо в панель вместо повторного логина.
 *
 * ЕДИНСТВЕННАЯ страница проекта на английском, кроме страницы фото букета: сюда попадают
 * снаружи, а магазины работают в Лос-Анджелесе. Сам дашборд остаётся русским — это рабочий
 * язык владельца, флористов и колл-центра (см. CLAUDE.md).
 */
export const metadata: Metadata = {
  title: "Floremart — one dashboard for flower shops",
  description: "Orders from your WooCommerce and Shopify stores in one place.",
};

export default async function Home() {
  const user = await getCurrentUser();
  const ctaHref = user ? homePathFor(user.role) : "/login";
  const ctaLabel = user ? "Open dashboard" : "Sign in";

  return (
    // lang на самой странице: корневой layout объявлен русским ради дашборда, а этот текст
    // английский — иначе переводчики и читалки экрана произносят его по-русски.
    <div lang="en" className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
        <Image src="/logo.png" alt="FloreMart" width={940} height={188} priority className="h-7 w-auto" />
        <Link
          href={ctaHref}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-900"
        >
          {ctaLabel}
        </Link>
      </header>

      <main className="mx-auto flex max-w-3xl flex-1 flex-col items-center justify-center px-6 py-24 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
          One dashboard for flower shops
        </h1>
        <p className="mt-6 max-w-xl text-lg text-slate-600">
          Floremart brings orders from your WooCommerce and Shopify stores into one place, with
          automatic assignment to florists, clear pricing, and roles for your team and call center.
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
