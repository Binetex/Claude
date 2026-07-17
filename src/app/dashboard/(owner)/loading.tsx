import { CardListSkeleton } from "@/components/ui/states";

/** Мгновенный скелетон при навигации по разделам владельца (Next.js route loading UI). */
export default function Loading() {
  return (
    <div className="p-6">
      <CardListSkeleton />
    </div>
  );
}
