import { redirect } from "next/navigation";

/** Корень раздела открывает первую вкладку — как /dashboard у владельца открывает заказы. */
export default function SettingsIndexPage() {
  redirect("/dashboard/settings/users");
}
