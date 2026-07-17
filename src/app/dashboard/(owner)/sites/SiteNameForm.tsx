"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ownerUpdateSiteName } from "@/app/dashboard/(owner)/actions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function SiteNameForm({ siteId, name }: { siteId: string; name: string }) {
  const [value, setValue] = useState(name);
  const [pending, start] = useTransition();

  return (
    <div className="flex items-center gap-2">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-8 w-44 font-semibold text-slate-800"
      />
      <Button
        size="sm"
        onClick={() => start(async () => { await ownerUpdateSiteName(siteId, value); toast.success("Название сохранено"); })}
        disabled={pending || !value.trim() || value === name}
      >
        Сохранить
      </Button>
    </div>
  );
}
