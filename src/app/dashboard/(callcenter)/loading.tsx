import { CardListSkeleton } from "@/components/ui/states";

/** Скелетон при навигации в разделе колл-центра. */
export default function Loading() {
  return (
    <div className="p-4">
      <CardListSkeleton rows={4} />
    </div>
  );
}
