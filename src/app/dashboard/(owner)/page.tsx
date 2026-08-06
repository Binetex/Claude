import { redirect } from "next/navigation";

// Сводного дашборда больше нет: владельцу он ничего не давал, точка входа — список заказов.
// Страница остаётся только редиректом, чтобы старые ссылки и закладки на /dashboard не падали.
export default function DashboardPage() {
  redirect("/dashboard/orders");
}
