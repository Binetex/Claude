"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Package, Pencil, Plus, Trash2, Truck, UserRound } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatMoney } from "@/lib/money";
import { CatalogPicker } from "./CatalogPicker";
import { ItemDialog } from "./ItemDialog";
import { emptyCustomItem, lineCustomer, lineFlorist, type DraftItem } from "./itemTypes";
import { ownerCreateManualOrder } from "./actions";

/**
 * Форма ручного заказа: три блока на одной странице, без мастера и без автосохранения.
 *
 * Всё собрано из компонентов, которые уже есть в проекте: Popover вместо DropdownMenu и
 * вместо Command, Dialog вместо Sheet, <details> вместо Collapsible. Новых зависимостей
 * ради одной формы не добавляется.
 */
export function ManualOrderForm({
  sites,
  florists,
}: {
  sites: { id: string; name: string }[];
  florists: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [items, setItems] = useState<DraftItem[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [editing, setEditing] = useState<DraftItem | null>(null);

  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [deliveryDate, setDeliveryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [deliveryWindow, setDeliveryWindow] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [addressLine, setAddressLine] = useState("");
  const [apartment, setApartment] = useState("");
  const [city, setCity] = useState("");
  const [zip, setZip] = useState("");
  const [cardMessage, setCardMessage] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [deliveryInstructions, setDeliveryInstructions] = useState("");
  const [senderName, setSenderName] = useState("");
  const [senderPhone, setSenderPhone] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [floristId, setFloristId] = useState("");
  const [deliveryCustomerCost, setDeliveryCustomerCost] = useState("0");
  const [tax, setTax] = useState("0");
  const [tip, setTip] = useState("0");
  const [discount, setDiscount] = useState("0");

  const num = (v: string) => {
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  const totals = useMemo(() => {
    const customerItems = items.reduce((a, i) => a + lineCustomer(i), 0);
    const florist = items.reduce((a, i) => a + lineFlorist(i), 0);
    const total = customerItems + num(tax) + num(tip) + num(deliveryCustomerCost) - num(discount);
    return { customerItems, florist, total };
  }, [items, tax, tip, deliveryCustomerCost, discount]);

  function move(index: number, dir: -1 | 1) {
    setItems((list) => {
      const next = [...list];
      const to = index + dir;
      if (to < 0 || to >= next.length) return list;
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
  }

  function upsert(item: DraftItem) {
    setItems((list) => (list.some((i) => i.key === item.key) ? list.map((i) => (i.key === item.key ? item : i)) : [...list, item]));
  }

  const canSubmit =
    items.length > 0 && siteId && deliveryDate && recipientName.trim() && recipientPhone.trim() && addressLine.trim() && city.trim() && zip.trim();

  function submit() {
    start(async () => {
      const res = await ownerCreateManualOrder({
        siteId,
        deliveryDate,
        deliveryWindow: deliveryWindow.trim() || "—",
        recipientName,
        recipientPhone,
        recipientEmail,
        addressLine,
        apartment,
        city,
        zip,
        senderName,
        senderPhone,
        senderEmail,
        cardMessage,
        customerNote,
        deliveryInstructions,
        floristId: floristId || null,
        deliveryCustomerCost: num(deliveryCustomerCost),
        tax: num(tax),
        tip: num(tip),
        discount: num(discount),
        items: items.map((i) =>
          i.kind === "catalog"
            ? {
                kind: "catalog" as const,
                productId: i.productId!,
                variantId: i.variantId,
                quantity: i.quantity,
                customerPrice: i.customerPrice,
                floristPrice: i.floristPrice,
                composition: i.composition,
              }
            : {
                kind: "custom" as const,
                name: i.name,
                quantity: i.quantity,
                customerPrice: i.customerPrice,
                floristPrice: i.floristPrice,
                composition: i.composition,
                imageUrl: i.image,
                financialType: i.financialType,
                purchaseCostCents: i.purchaseCostCents,
              }
        ),
      });

      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`Заказ ${res.orderNumber} создан`);
      router.push(`/dashboard/orders/${res.orderId}`);
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        {/* ── 1. Позиции ── */}
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <CardTitle icon={Package}>Позиции</CardTitle>
            {/* Popover вместо DropdownMenu: двух действий ему хватает, а зависимости не нужно. */}
            <Popover open={addOpen} onOpenChange={setAddOpen}>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline">
                  <Plus className="size-4" />
                  Добавить позицию
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-1.5">
                <button
                  type="button"
                  onClick={() => { setAddOpen(false); setCatalogOpen(true); }}
                  className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                >
                  Выбрать товар из каталога
                </button>
                <button
                  type="button"
                  onClick={() => { setAddOpen(false); setEditing(emptyCustomItem()); }}
                  className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                >
                  Добавить свою позицию
                </button>
              </PopoverContent>
            </Popover>
          </CardHeader>

          <CardBody className="p-0">
            {items.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-slate-400">
                Пока пусто. Добавьте товар из каталога или свою позицию.
              </p>
            ) : (
              <ul className="divide-y divide-slate-50">
                {items.map((i, idx) => (
                  <li key={i.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
                    {i.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={i.image} alt="" className="size-12 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <span className="size-12 shrink-0 rounded-lg bg-slate-100" />
                    )}
                    <div className="min-w-[9rem] flex-1">
                      <div className="text-sm font-medium break-words text-slate-800">{i.name}</div>
                      {i.variantName && <div className="text-xs text-slate-500">{i.variantName}</div>}
                      {i.kind === "custom" && <div className="text-[11px] text-slate-400">своя позиция</div>}
                    </div>
                    <div className="text-right text-sm whitespace-nowrap">
                      <div className="text-slate-800 tabular-nums">
                        {formatMoney(lineCustomer(i))} <span className="text-xs text-slate-400">× {i.quantity}</span>
                      </div>
                      <div className="text-xs text-slate-500 tabular-nums">{formatMoney(lineFlorist(i))} флористу</div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-0.5">
                      <Button variant="ghost" size="iconSm" aria-label="Выше" disabled={idx === 0} onClick={() => move(idx, -1)}>
                        <ChevronUp className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="iconSm"
                        aria-label="Ниже"
                        disabled={idx === items.length - 1}
                        onClick={() => move(idx, 1)}
                      >
                        <ChevronDown className="size-4" />
                      </Button>
                      <Button variant="ghost" size="iconSm" aria-label="Изменить" onClick={() => setEditing(i)}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="iconSm"
                        aria-label="Удалить"
                        className="text-red-600 hover:bg-red-50"
                        onClick={() => setItems((l) => l.filter((x) => x.key !== i.key))}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>

          {items.length > 0 && (
            <div className="space-y-1 border-t border-slate-100 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Сумма клиента</span>
                <span className="font-semibold text-slate-900 tabular-nums">{formatMoney(totals.customerItems)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Сумма флориста</span>
                <span className="text-slate-700 tabular-nums">{formatMoney(totals.florist)}</span>
              </div>
            </div>
          )}
        </Card>

        {/* ── 2. Получатель и доставка ── */}
        <Card>
          <CardHeader className="py-2.5"><CardTitle icon={UserRound}>Получатель и доставка</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Магазин" htmlFor="f-site">
                <Select id="f-site" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
              <Field label="Дата доставки" htmlFor="f-date">
                <Input id="f-date" type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
              </Field>
              <Field label="Интервал" htmlFor="f-window">
                <Input id="f-window" value={deliveryWindow} onChange={(e) => setDeliveryWindow(e.target.value)} placeholder="12:00 – 16:00" />
              </Field>
              <Field label="Имя получателя" htmlFor="f-rname">
                <Input id="f-rname" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} required />
              </Field>
              <Field label="Телефон получателя" htmlFor="f-rphone">
                <Input id="f-rphone" value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} required />
              </Field>
              <Field label="Город" htmlFor="f-city">
                <Input id="f-city" value={city} onChange={(e) => setCity(e.target.value)} required />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Адрес" htmlFor="f-addr">
                  <Input id="f-addr" value={addressLine} onChange={(e) => setAddressLine(e.target.value)} required />
                </Field>
              </div>
              <Field label="Квартира / этаж" htmlFor="f-apt">
                <Input id="f-apt" value={apartment} onChange={(e) => setApartment(e.target.value)} />
              </Field>
              <Field label="Индекс" htmlFor="f-zip">
                <Input id="f-zip" value={zip} onChange={(e) => setZip(e.target.value)} required />
              </Field>
            </div>

            <Separator />

            <Field label="Текст открытки" htmlFor="f-card">
              <Textarea id="f-card" rows={2} value={cardMessage} onChange={(e) => setCardMessage(e.target.value)} />
            </Field>
            <Field label="Заметка" htmlFor="f-note">
              <Textarea id="f-note" rows={2} value={customerNote} onChange={(e) => setCustomerNote(e.target.value)} />
            </Field>

            {/* Редкое — под раскрывашкой, чтобы обычный заказ оформлялся в одно движение. */}
            <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium text-slate-700">Дополнительно</summary>
              <div className="mt-3 space-y-3">
                <p className="text-[11px] text-slate-500">
                  Заказчик — тот, кто платил. Оставьте пустым, и им станет получатель: без этих полей
                  заказ в базе не сохранить, а SMS «заказчику» должны куда-то уходить.
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Имя заказчика" htmlFor="f-sname">
                    <Input id="f-sname" value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="= получатель" />
                  </Field>
                  <Field label="Телефон заказчика" htmlFor="f-sphone">
                    <Input id="f-sphone" value={senderPhone} onChange={(e) => setSenderPhone(e.target.value)} placeholder="= получатель" />
                  </Field>
                  <Field label="Email заказчика" htmlFor="f-semail">
                    <Input id="f-semail" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} />
                  </Field>
                  <Field label="Email получателя" htmlFor="f-remail">
                    <Input id="f-remail" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} />
                  </Field>
                </div>
                <Field label="Инструкции доставки" htmlFor="f-dinstr">
                  <Textarea id="f-dinstr" rows={2} value={deliveryInstructions} onChange={(e) => setDeliveryInstructions(e.target.value)} />
                </Field>
              </div>
            </details>
          </CardBody>
        </Card>
      </div>

      {/* ── 3. Флорист и итог ── */}
      <div className="min-w-0">
        <div className="sticky top-16 space-y-4">
          <Card>
            <CardHeader className="py-2.5"><CardTitle icon={Truck}>Флорист и итог</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              <Field label="Флорист" htmlFor="f-florist">
                <Select id="f-florist" value={floristId} onChange={(e) => setFloristId(e.target.value)}>
                  <option value="">Назначить позже</option>
                  {florists.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </Select>
              </Field>

              <Separator />

              <div className="grid grid-cols-2 gap-3">
                <Field label="Доставка с клиента" htmlFor="f-deliv">
                  <Input id="f-deliv" inputMode="decimal" value={deliveryCustomerCost} onChange={(e) => setDeliveryCustomerCost(e.target.value)} />
                </Field>
                <Field label="Налог" htmlFor="f-tax">
                  <Input id="f-tax" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} />
                </Field>
                <Field label="Чаевые" htmlFor="f-tip">
                  <Input id="f-tip" inputMode="decimal" value={tip} onChange={(e) => setTip(e.target.value)} />
                </Field>
                <Field label="Скидка" htmlFor="f-disc">
                  <Input id="f-disc" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} />
                </Field>
              </div>

              <Separator />

              <div className="space-y-1 text-sm">
                <Row label="Позиции" value={totals.customerItems} />
                <Row label="Доставка" value={num(deliveryCustomerCost)} />
                <Row label="Налог" value={num(tax)} />
                <Row label="Чаевые" value={num(tip)} />
                <Row label="Скидка" value={-num(discount)} />
              </div>

              <div className="flex items-baseline justify-between border-t border-slate-100 pt-2">
                <span className="text-sm font-medium text-slate-800">Итого с клиента</span>
                <span className="text-xl font-bold text-slate-900 tabular-nums">{formatMoney(totals.total)}</span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-slate-500">Флористу</span>
                <span className="text-slate-700 tabular-nums">{formatMoney(totals.florist)}</span>
              </div>

              <Button className="w-full" disabled={!canSubmit || pending} onClick={submit}>
                {pending ? "Создаю…" : "Создать заказ"}
              </Button>
              {!canSubmit && (
                <p className="text-[11px] text-slate-400">
                  Нужны позиция, магазин, дата, получатель с телефоном и адрес.
                </p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Пикер каталога живёт РЯДОМ с меню, а не внутри него: вложенный поповер
          закрывался вместе с родительским и не успевал открыться. */}
      <CatalogPicker sites={sites} open={catalogOpen} onOpenChange={setCatalogOpen} onPick={upsert} />

      {editing && (
        <ItemDialog
          item={editing}
          open
          onOpenChange={(v) => { if (!v) setEditing(null); }}
          onSave={(i) => { upsert(i); setEditing(null); }}
        />
      )}
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-700 tabular-nums">{formatMoney(value)}</span>
    </div>
  );
}
