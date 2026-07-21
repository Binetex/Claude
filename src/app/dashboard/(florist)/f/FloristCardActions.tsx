"use client";
import { useTransition } from "react";
import { floristAccept } from "@/app/dashboard/(florist)/actions";
import { FloristHandoff } from "./FloristHandoff";

export function FloristAcceptDecline({ orderId, florists, size = "sm" }: { orderId: string; florists: { id: string; name: string }[]; size?: "sm" | "lg" }) {
  const [pending, start] = useTransition();
  const cls = size === "lg" ? "py-3 text-base" : "py-2 text-sm";
  return (
    <div className="grid grid-cols-2 gap-2" onClick={(e) => e.preventDefault()}>
      <button
        disabled={pending}
        onClick={() => start(() => floristAccept(orderId))}
        className={`rounded-lg bg-emerald-600 px-4 font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 ${cls}`}
      >
        Принять
      </button>
      <FloristHandoff
        orderId={orderId}
        florists={florists}
        btnClass={`rounded-lg border border-red-300 bg-white px-4 font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60 ${cls}`}
      />
    </div>
  );
}
