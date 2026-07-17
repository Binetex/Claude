import { CardListSkeleton } from "@/components/ui/states";

/** Скелетон при навигации в разделе флориста. */
export default function Loading() {
  return (
    <div className="p-4">
      <CardListSkeleton rows={3} />
    </div>
  );
}
