"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { requiredScopesText } from "@/integrations/shopify/customApp/scopes";

/** Копирует минимальный список scopes для вставки при создании Custom App в Dev Dashboard. */
export function CopyScopesButton() {
  const [copied, setCopied] = useState(false);
  const scopes = requiredScopesText();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label="Скопировать список обязательных scopes"
      onClick={() => {
        navigator.clipboard?.writeText(scopes).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Скопировано" : "Copy scopes"}
    </Button>
  );
}
