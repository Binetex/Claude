import Link from "next/link";
import { EmptyState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";

/** Дружелюбная 404 вместо дефолтной страницы Next. */
export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <EmptyState
        title="Страница не найдена"
        description="Возможно, ссылка устарела или адрес введён неверно."
        icon={<span className="text-4xl">🌸</span>}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard">На главную</Link>
          </Button>
        }
      />
    </div>
  );
}
