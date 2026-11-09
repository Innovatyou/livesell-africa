import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import type { Env } from '../config/env';
import { Prisma, WhatsappConversation } from '../generated/prisma/client';
import { InsufficientStockError } from '../inventory/inventory.service';
import { DeliveryService } from '../logistics/delivery.service';
import { NotificationService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { BankTransferService } from '../payments/bank-transfer.service';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { formatMinor } from './order-notifier.service';

const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 30; // inbound messages per phone per 10 minutes
const CONVERSATION_TTL_MS = 24 * 3_600_000;
const MAX_QTY = 20;
const CODE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{2,39}$/;
/** Words in "ORDER ada BAG001" / "I want BAG001" that are never a store name. */
const STOP_WORDS = new Set(['order', 'buy', 'want', 'need', 'please', 'pls', 'hello', 'hi', 'hey', 'the', 'and', 'for', 'from', 'store', 'shop', 'code', 'item', 'product', 'yes', 'help', 'menu', 'status', 'cancel', 'stop', 'start', 'pickup']);

type State = 'IDLE' | 'AWAIT_STORE' | 'AWAIT_VARIANT' | 'AWAIT_QTY' | 'AWAIT_NAME' | 'AWAIT_ADDRESS' | 'CONFIRM';
interface Draft {
  code?: string;
  productName?: string;
  variants?: Array<{ id: string; label: string; priceMinor: string; available: number }>;
  variantId?: string;
  variantLabel?: string;
  priceMinor?: string;
  quantity?: number;
  fullName?: string;
  address?: { line1: string; city: string; state: string } | null;
  suggestedAddress?: { line1: string; city: string; state: string } | null;
  optedOut?: boolean;
  lastOrderId?: string;
}

/**
 * Pure: what a message asks for (unit-tested). A word can be a store name ("ada-fashion", "shop24") or a product
 * code ("BAG001"), so both lists are returned and the service decides by looking the store up.
 */
export function parseMessage(text: string): { command: string | null; words: string[]; candidates: string[]; codes: string[] } {
  const clean = text.trim().replace(/\s+/g, ' ');
  const command = /^(STOP|UNSUBSCRIBE|START|SUBSCRIBE|HELP|MENU|CANCEL|STATUS|YES|NO|PICKUP)\b/.exec(clean.toUpperCase())?.[1] ?? null;
  const words = clean.split(' ').filter(Boolean);
  const candidates: string[] = [];
  const codes: string[] = [];
  for (const raw of words) {
    const w = raw.replace(/^[@#]/, '').replace(/[.,!?:;]+$/, '');
    if (SLUG.test(w.toLowerCase()) && !STOP_WORDS.has(w.toLowerCase()) && candidates.length < 4) candidates.push(w.toLowerCase());
    if (CODE.test(w.toUpperCase()) && /\d/.test(w) && codes.length < 4) codes.push(w.toUpperCase());
  }
  return { command, words, candidates, codes };
}

/** Pure: "12 Allen Avenue, Ikeja, Lagos" → parts (street may itself contain commas). */
export function parseAddress(text: string): { line1: string; city: string; state: string } | null {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const state = parts.pop()!;
  const city = parts.pop()!;
  const line1 = parts.join(', ');
  if (line1.length < 3 || line1.length > 200 || city.length < 2 || city.length > 80 || state.length < 2 || state.length > 80) return null;
  return { line1, city, state };
}

/**
 * WhatsApp ordering on the platform number (MASTER-SPEC §16). Veltrix forwards each inbound message (signed); this
 * service runs a small conversation per customer phone:
 *
 *   "ada-fashion BAG001" → product (and store) → variant → quantity → name → address → confirm → order + private
 *   link with "Pay now" and bank-transfer details. After payment verification the order confirmation is sent by the
 *   order notifier (outbox).
 *
 * Commands at any point: STOP / START (opt-out management), HELP, CANCEL, STATUS (latest orders and their links).
 * Prices and stock always come from the database; an order placed here is an ordinary unpaid order with a stock hold.
 */
@Injectable()
export class WhatsappCommerceService {
  private readonly logger = new Logger(WhatsappCommerceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Env, true>,
    private readonly notifications: NotificationService,
    private readonly orders: OrdersService,
    private readonly transfers: BankTransferService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    private readonly delivery: DeliveryService,
  ) {}

  /** A forwarded delivery that passed signature checks. De-duplicated on the WhatsApp message id / delivery id. */
  async handleDelivery(deliveryId: string, body: { event?: string; data?: Record<string, unknown> }) {
    const event = String(body.event ?? '');
    const d = body.data ?? {};
    const key = event === 'message.received' && d.wa_message_id ? `wa:${String(d.wa_message_id)}` : `dl:${deliveryId}`;
    const phone = event === 'message.received' ? normalisePhone(String(d.from ?? '')) : null;
    try {
      await this.prisma.whatsappInboundEvent.create({ data: { deliveryId: key.slice(0, 200), event: event.slice(0, 40), phone } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { duplicate: true };
      throw e;
    }
    if (event === 'message.status') {
      const n = await this.notifications.applyWhatsappStatus(String(d.wa_message_id ?? ''), String(d.status ?? ''), d.error ? String(d.error) : null);
      return { processed: true, updated: n };
    }
    if (event !== 'message.received' || !phone) return { processed: false };
    await this.onMessage(phone, String(d.name ?? ''), String(d.text ?? '').slice(0, 1000));
    return { processed: true };
  }

  async onMessage(phone: string, profileName: string, text: string): Promise<void> {
    const now = new Date();
    const existing = await this.prisma.whatsappConversation.findUnique({ where: { phone } });
    let conv: WhatsappConversation;
    if (!existing) {
      try {
        conv = await this.prisma.whatsappConversation.create({ data: { phone, lastInboundAt: now, inboundCount: 1, windowStart: now, windowCount: 1 } });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        return this.onMessage(phone, profileName, text); // created concurrently: take the update path
      }
    } else {
      const fresh = now.getTime() - existing.windowStart.getTime() > RATE_WINDOW_MS;
      if (!fresh && existing.windowCount >= RATE_MAX) return; // flooding: ignore quietly
      const stale = now.getTime() - existing.lastInboundAt.getTime() > CONVERSATION_TTL_MS;
      conv = await this.prisma.whatsappConversation.update({
        where: { id: existing.id },
        data: {
          lastInboundAt: now, inboundCount: { increment: 1 }, ...(fresh ? { windowStart: now, windowCount: 1 } : { windowCount: { increment: 1 } }),
          // A conversation idle for a day starts over (the store binding goes too).
          ...(stale ? { state: 'IDLE', tenantId: null, data: { optedOut: (existing.data as Draft).optedOut ?? false } } : {}),
        },
      });
    }
    const draft = (conv.data ?? {}) as Draft;
    const m = parseMessage(text);

    if (m.command === 'STOP' || m.command === 'UNSUBSCRIBE') return this.optOut(conv);
    if (m.command === 'START' || m.command === 'SUBSCRIBE') return this.optIn(conv);
    if (draft.optedOut) return; // opted out: say nothing until START
    if (m.command === 'HELP' || m.command === 'MENU') return this.reply(conv, HELP);
    if (m.command === 'STATUS') return this.status(conv);
    if (m.command === 'CANCEL') {
      await this.save(conv, 'IDLE', { optedOut: false, lastOrderId: draft.lastOrderId });
      return this.reply(conv, 'Cancelled. Send a product code (e.g. BAG001) whenever you want to order.');
    }

    switch (conv.state as State) {
      case 'AWAIT_STORE': return this.pickStore(conv, draft, m.candidates);
      case 'AWAIT_VARIANT': return this.pickVariant(conv, draft, text);
      case 'AWAIT_QTY': return this.pickQuantity(conv, draft, text);
      case 'AWAIT_NAME': return this.pickName(conv, draft, text);
      case 'AWAIT_ADDRESS': return this.pickAddress(conv, draft, text, m.command);
      case 'CONFIRM':
        if (m.command === 'YES') return this.placeOrder(conv, draft, profileName);
        if (m.command === 'NO') {
          await this.save(conv, 'IDLE', { lastOrderId: draft.lastOrderId });
          return this.reply(conv, 'No problem — nothing was ordered. Send a product code to start again.');
        }
        return this.reply(conv, 'Reply YES to place the order, or CANCEL.');
      default:
        return this.start(conv, draft, m);
    }
  }

  // ───────────────────────── steps ─────────────────────────

  private async start(conv: WhatsappConversation, draft: Draft, m: ReturnType<typeof parseMessage>) {
    // A store named in the message wins; otherwise the store this conversation is already with.
    let named: { id: string; businessName: string } | null = null;
    let storeWord: string | null = null;
    for (const c of m.candidates) {
      named = await this.store(c);
      if (named) { storeWord = c; break; }
    }
    // "<store> <code>" is the usual order, so without a known store the last code-like word is the product.
    const code = (storeWord ? m.codes.find((c) => c.toLowerCase() !== storeWord) : m.codes[m.codes.length - 1]) ?? null;
    if (!code) {
      if (named) {
        await this.save(conv, 'IDLE', { lastOrderId: draft.lastOrderId }, named.id);
        return this.reply(conv, `Welcome to ${named.businessName}! Send the code of the product you want (e.g. BAG001), as shown in the live or on the store page.`);
      }
      return this.reply(conv, HELP);
    }
    let tenantId: string | null = named?.id ?? conv.tenantId ?? null;
    if (!tenantId) {
      // Which published stores sell this code?
      const rows = await this.prisma.$queryRaw<Array<{ tenant_id: string }>>`
        SELECT DISTINCT p.tenant_id FROM products p JOIN storefront_settings s ON s.tenant_id = p.tenant_id
         WHERE p.product_code = ${code} AND p.status = 'ACTIVE' AND p.deleted_at IS NULL AND s.is_published = true LIMIT 3`;
      if (rows.length === 1) tenantId = rows[0].tenant_id;
      else if (rows.length > 1) {
        await this.save(conv, 'AWAIT_STORE', { code, lastOrderId: draft.lastOrderId });
        return this.reply(conv, `Several stores sell ${code}. Reply with the store name from the live or link (e.g. ada-fashion).`);
      }
    }
    if (!tenantId) return this.reply(conv, `I couldn't find ${code}. Check the code from the live or the store page and send it again.`);
    return this.showProduct(conv, tenantId, code, draft);
  }

  private async pickStore(conv: WhatsappConversation, draft: Draft, candidates: string[]) {
    for (const c of candidates) {
      const t = await this.store(c);
      if (t) return this.showProduct(conv, t.id, draft.code!, draft);
    }
    return this.reply(conv, 'I couldn’t find that store. Reply with the store name exactly as on its link, or CANCEL.');
  }

  private async showProduct(conv: WhatsappConversation, tenantId: string, code: string, draft: Draft) {
    const p = await this.prisma.forTenant(tenantId).product.findFirst({
      where: { productCode: code, status: 'ACTIVE', deletedAt: null },
      include: { variants: { where: { isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], include: { inventory: { select: { onHand: true, reserved: true } } } } },
    });
    if (!p || !p.variants.length) {
      await this.save(conv, 'IDLE', { lastOrderId: draft.lastOrderId }, tenantId);
      return this.reply(conv, `I couldn't find ${code} in this store. Check the code and send it again.`);
    }
    const store = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { businessName: true, defaultCurrency: true } });
    const variants = p.variants.map((v) => ({
      id: v.id, label: v.name === 'Default' ? p.name : v.name, priceMinor: (v.promoPriceMinor ?? v.priceMinor).toString(),
      available: Math.max(0, (v.inventory?.onHand ?? 0) - (v.inventory?.reserved ?? 0)),
    }));
    if (variants.every((v) => v.available <= 0)) {
      await this.save(conv, 'IDLE', { lastOrderId: draft.lastOrderId }, tenantId);
      return this.reply(conv, `Sorry, ${p.name} is sold out at ${store.businessName} right now.`);
    }
    const base: Draft = { code, productName: p.name, variants, lastOrderId: draft.lastOrderId };
    if (variants.length === 1) {
      const v = variants[0];
      await this.save(conv, 'AWAIT_QTY', { ...base, variantId: v.id, variantLabel: p.name, priceMinor: v.priceMinor }, tenantId);
      return this.reply(conv, `Welcome to ${store.businessName}! You selected ${p.name}.\nPrice: ${formatMinor(v.priceMinor, store.defaultCurrency)}.\n\nHow many would you like? (1–${Math.min(MAX_QTY, v.available)})`);
    }
    await this.save(conv, 'AWAIT_VARIANT', base, tenantId);
    const lines = variants.map((v, i) => `${i + 1}. ${v.label} — ${formatMinor(v.priceMinor, store.defaultCurrency)}${v.available <= 0 ? ' (sold out)' : ''}`).join('\n');
    return this.reply(conv, `Welcome to ${store.businessName}! You selected ${p.name}.\n\nAvailable options:\n${lines}\n\nReply with the number of your choice.`);
  }

  private async pickVariant(conv: WhatsappConversation, draft: Draft, text: string) {
    const vs = draft.variants ?? [];
    const n = Number.parseInt(text.trim(), 10);
    const v = Number.isInteger(n) && n >= 1 && n <= vs.length ? vs[n - 1] : vs.find((x) => x.label.toLowerCase() === text.trim().toLowerCase());
    if (!v) return this.reply(conv, `Reply with a number from 1 to ${vs.length}, or CANCEL.`);
    if (v.available <= 0) return this.reply(conv, `${v.label} is sold out. Please choose another option.`);
    await this.save(conv, 'AWAIT_QTY', { ...draft, variantId: v.id, variantLabel: `${draft.productName} (${v.label})`, priceMinor: v.priceMinor });
    return this.reply(conv, `${draft.productName} — ${v.label}. How many would you like? (1–${Math.min(MAX_QTY, v.available)})`);
  }

  private async pickQuantity(conv: WhatsappConversation, draft: Draft, text: string) {
    const q = Number(text.trim());
    if (!Number.isInteger(q) || q < 1 || q > MAX_QTY) return this.reply(conv, `Reply with a quantity from 1 to ${MAX_QTY}.`);
    const v = await this.prisma.forTenant(conv.tenantId!).productVariant.findUnique({ where: { id: draft.variantId! }, include: { inventory: { select: { onHand: true, reserved: true } } } });
    const available = Math.max(0, (v?.inventory?.onHand ?? 0) - (v?.inventory?.reserved ?? 0));
    if (available < q) return this.reply(conv, available > 0 ? `Only ${available} left. Reply with a quantity up to ${available}.` : 'Sorry, that just sold out. Send another product code, or CANCEL.');
    const existing = await this.prisma.forTenant(conv.tenantId!).customer.findFirst({
      where: { phone: conv.phone, anonymizedAt: null }, include: { addresses: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }], take: 1 } },
    });
    if (existing) {
      const a = existing.addresses[0];
      const suggested = a ? { line1: a.line1, city: a.city, state: a.state } : null;
      await this.save(conv, 'AWAIT_ADDRESS', { ...draft, quantity: q, fullName: existing.fullName, suggestedAddress: suggested });
      return this.reply(conv, suggested
        ? `Thanks ${existing.fullName.split(' ')[0]}! Deliver to ${suggested.line1}, ${suggested.city}, ${suggested.state}?\nReply YES, send a new address (street, city, state), or PICKUP.`
        : `Thanks ${existing.fullName.split(' ')[0]}! Send your delivery address as: street, city, state — or reply PICKUP.`);
    }
    await this.save(conv, 'AWAIT_NAME', { ...draft, quantity: q });
    return this.reply(conv, 'What is your full name?');
  }

  private async pickName(conv: WhatsappConversation, draft: Draft, text: string) {
    const name = text.trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 120 || /\d{4,}/.test(name)) return this.reply(conv, 'Please send your full name (e.g. Amaka Nnaji).');
    await this.save(conv, 'AWAIT_ADDRESS', { ...draft, fullName: name });
    return this.reply(conv, 'Send your delivery address as: street, city, state (e.g. 12 Allen Avenue, Ikeja, Lagos) — or reply PICKUP.');
  }

  private async pickAddress(conv: WhatsappConversation, draft: Draft, text: string, command: string | null) {
    let address: Draft['address'];
    if (command === 'PICKUP') address = null;
    else if (command === 'YES' && draft.suggestedAddress) address = draft.suggestedAddress;
    else {
      const a = parseAddress(text);
      if (!a) return this.reply(conv, 'Please send the address as: street, city, state (e.g. 12 Allen Avenue, Ikeja, Lagos) — or PICKUP.');
      address = a;
    }
    // The store's own zones price the delivery (Phase 10); pickup only where the store offers it.
    const opts = await this.delivery.options(conv.tenantId!, address);
    if (!address && !opts.pickup.available) return this.reply(conv, 'This store doesn’t offer pickup. Please send a delivery address as: street, city, state.');
    if (address && !opts.delivery.available) return this.reply(conv, `This store doesn’t deliver to ${address.city}, ${address.state} yet.${opts.pickup.available ? ' Reply PICKUP to collect it instead, or' : ' Please'} message the seller.`);
    const store = await this.prisma.tenant.findUniqueOrThrow({ where: { id: conv.tenantId! }, select: { businessName: true, defaultCurrency: true } });
    const goods = BigInt(draft.priceMinor!) * BigInt(draft.quantity!);
    const fee = address ? opts.delivery.feeMinor ?? 0n : 0n;
    await this.save(conv, 'CONFIRM', { ...draft, address });
    return this.reply(conv, [
      `Order summary — ${store.businessName}`,
      `${draft.quantity} × ${draft.variantLabel} = ${formatMinor(goods, store.defaultCurrency)}`,
      ...(fee > 0n ? [`Delivery (${opts.delivery.zone?.name ?? 'your area'}): ${formatMinor(fee, store.defaultCurrency)}`, `Total: ${formatMinor(goods + fee, store.defaultCurrency)}`] : []),
      `Name: ${draft.fullName}`,
      address ? `Deliver to: ${address.line1}, ${address.city}, ${address.state}` : `Pickup: ${opts.pickup.address}`,
      ...(address && opts.delivery.feeToBeAgreed ? ['Any delivery fee is agreed with the seller.'] : []),
      ...(address && opts.delivery.zone?.etaDays != null ? [`Usually delivered within ${opts.delivery.zone.etaDays} day(s) of payment.`] : []),
      '',
      'Reply YES to place the order, or CANCEL.',
    ].join('\n'));
  }

  private async placeOrder(conv: WhatsappConversation, draft: Draft, profileName: string) {
    const tenantId = conv.tenantId!;
    const token = this.crypto.randomToken(24);
    let order: { id: string; reference: string };
    try {
      // Priced again at placement: a zone may have changed since the summary.
      const price = await this.delivery.priceFor(tenantId, draft.address ? 'DELIVERY' : 'PICKUP', draft.address ?? null);
      order = await this.orders.create(tenantId, {
        customer: { fullName: draft.fullName ?? (profileName || 'WhatsApp customer'), phone: conv.phone },
        items: [{ variantId: draft.variantId!, quantity: draft.quantity! }],
        ...(draft.address ? { shippingAddress: draft.address } : {}),
        confirm: true,
      } as never, { actorId: null, source: 'whatsapp', trackingTokenHash: this.crypto.hashToken(token), trackingTokenEnc: this.crypto.encrypt(token, tenantId), whatsappOptIn: true, delivery: price });
    } catch (e) {
      if (e instanceof InsufficientStockError) {
        await this.save(conv, 'IDLE', { lastOrderId: draft.lastOrderId });
        return this.reply(conv, 'Sorry — that item sold out while we were talking. Send another product code to try something else.');
      }
      if (e instanceof BadRequestException) {
        await this.save(conv, 'IDLE', { lastOrderId: draft.lastOrderId });
        return this.reply(conv, 'Delivery options at this store just changed, so nothing was ordered. Send the product code again to start over.');
      }
      if (e instanceof ForbiddenException || e instanceof NotFoundException) {
        await this.save(conv, 'IDLE', { lastOrderId: draft.lastOrderId });
        return this.reply(conv, "This store can't take orders right now. Please message the seller directly.");
      }
      throw e;
    }
    await this.save(conv, 'IDLE', { lastOrderId: order.id });
    await this.audit.record({ action: 'order.whatsapp_placed', tenantId, entityType: 'order', entityId: order.id, metadata: { reference: order.reference } });

    const o = await this.prisma.forTenant(tenantId).order.findUniqueOrThrow({ where: { id: order.id }, select: { totalMinor: true, currency: true, reservationExpiresAt: true } });
    const store = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, businessName: true } });
    const link = `${this.config.get('APP_URL', { infer: true })}/store/${store.slug}/order/${order.reference}?token=${encodeURIComponent(token)}`;
    const online = (await this.payments.availability(tenantId)).online;
    const accounts = await this.transfers.publicAccounts(tenantId);
    const lines = [
      `✅ Order ${order.reference} placed with ${store.businessName}.`,
      `Total: ${formatMinor(o.totalMinor, o.currency)}`,
      '',
      online ? `Pay online (card, transfer, USSD): ${link}` : `Your order page: ${link}`,
    ];
    if (accounts.length) {
      const a = accounts[0];
      lines.push('', `Or transfer to ${a.bankName} ${a.accountNumber} (${a.accountName}) with ${order.reference} as the description, then tap the link above and choose “I’ve sent the money”.`);
    }
    if (o.reservationExpiresAt) lines.push('', `Your items are held for you until ${new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' }).format(o.reservationExpiresAt)}.`);
    lines.push('', 'Reply STATUS any time to check your order.');
    return this.reply(conv, lines.join('\n'));
  }

  private async status(conv: WhatsappConversation) {
    // The customer's own orders, found by their WhatsApp number (across stores, or the current store).
    const customers = await this.prisma.customer.findMany({ where: { phone: conv.phone, anonymizedAt: null, ...(conv.tenantId ? { tenantId: conv.tenantId } : {}) }, select: { id: true, tenantId: true } });
    if (!customers.length) return this.reply(conv, 'You have no orders yet. Send a product code to order.');
    const orders = await this.prisma.order.findMany({
      where: { customerId: { in: customers.map((c) => c.id) }, status: { not: 'DRAFT' } }, orderBy: { createdAt: 'desc' }, take: 3,
      select: { reference: true, status: true, totalMinor: true, currency: true, tenantId: true, trackingTokenEnc: true, tenant: { select: { slug: true, businessName: true } } },
    });
    if (!orders.length) return this.reply(conv, 'You have no orders yet. Send a product code to order.');
    const app = this.config.get('APP_URL', { infer: true });
    const lines = orders.map((o) => {
      const link = o.trackingTokenEnc ? ` ${app}/store/${o.tenant.slug}/order/${o.reference}?token=${encodeURIComponent(this.crypto.decrypt(o.trackingTokenEnc, o.tenantId))}` : '';
      return `• ${o.reference} (${o.tenant.businessName}) — ${STATUS_WORDS[o.status] ?? o.status.toLowerCase()} — ${formatMinor(o.totalMinor, o.currency)}${link}`;
    });
    return this.reply(conv, `Your latest orders:\n${lines.join('\n')}`);
  }

  private async optOut(conv: WhatsappConversation) {
    const now = new Date();
    await this.save(conv, 'IDLE', { optedOut: true });
    // The phone's owner asked: every store's record for this number stops getting WhatsApp messages.
    const n = await this.prisma.customer.updateMany({ where: { phone: conv.phone }, data: { whatsappOptIn: false, whatsappOptOutAt: now } });
    await this.audit.record({ action: 'customer.whatsapp_opt_out', entityType: 'whatsapp_conversation', entityId: conv.id, metadata: { customers: n.count } });
    return this.reply(conv, 'You won’t get WhatsApp messages from LiveSell stores any more. Order updates may still come by SMS or email. Reply START to turn WhatsApp back on.');
  }

  private async optIn(conv: WhatsappConversation) {
    await this.save(conv, 'IDLE', { optedOut: false });
    const n = await this.prisma.customer.updateMany({ where: { phone: conv.phone, whatsappOptOutAt: { not: null } }, data: { whatsappOptIn: true, whatsappOptOutAt: null, optInAt: new Date() } });
    await this.audit.record({ action: 'customer.whatsapp_opt_in', entityType: 'whatsapp_conversation', entityId: conv.id, metadata: { customers: n.count } });
    return this.reply(conv, 'WhatsApp updates are back on. Send a product code (e.g. BAG001) whenever you want to order.');
  }

  // ───────────────────────── helpers ─────────────────────────

  private async store(slug: string) {
    const t = await this.prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, businessName: true, status: true, storefront: { select: { isPublished: true } }, subscriptions: { where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } }, select: { id: true }, take: 1 } },
    });
    if (!t || !t.storefront?.isPublished || t.status === 'SUSPENDED' || t.status === 'CLOSED' || !t.subscriptions.length) return null;
    return t;
  }

  private save(conv: WhatsappConversation, state: State, data: Draft, tenantId?: string) {
    return this.prisma.whatsappConversation.update({ where: { id: conv.id }, data: { state, data: data as Prisma.InputJsonValue, ...(tenantId !== undefined ? { tenantId } : {}) } }).then((c) => Object.assign(conv, c));
  }

  /** Replies are free text: the customer just wrote, so Meta's 24-hour window is open. Billed to the store once known. */
  private async reply(conv: WhatsappConversation, text: string) {
    try {
      await this.notifications.send({ tenantId: conv.tenantId, channel: 'WHATSAPP', type: 'WHATSAPP_REPLY', template: 'WHATSAPP_REPLY', destination: conv.phone, vars: { text } });
    } catch (e) {
      this.logger.warn(`WhatsApp reply to ${conv.phone.slice(0, 7)}…: ${(e as Error).message}`);
    }
  }
}

const HELP = 'Hi! To order, send the product code from the live or store page (e.g. BAG001), or the store name and code (e.g. ada-fashion BAG001).\nReply STATUS for your orders, CANCEL to start over, STOP to stop WhatsApp messages.';

const STATUS_WORDS: Record<string, string> = {
  PENDING_PAYMENT: 'awaiting payment', PAYMENT_VERIFICATION: 'payment being checked', PAID: 'paid', PROCESSING: 'being prepared',
  READY_FOR_DISPATCH: 'ready to send', DISPATCHED: 'on its way', DELIVERED: 'delivered', CANCELLED: 'cancelled', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partly refunded',
};

export function normalisePhone(raw: string): string | null {
  let p = raw.replace(/[^\d+]/g, '');
  if (/^0\d{10}$/.test(p)) p = `234${p.slice(1)}`;
  if (!p.startsWith('+')) p = `+${p}`;
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}
