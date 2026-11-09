import { escapeHtml } from './html';

/**
 * Customer messages about an order (Phase 9). Pure functions. Values are escaped in HTML; SMS/WhatsApp texts are
 * plain and short (WhatsApp free text is only used inside Meta's 24-hour window — outside it the approved template
 * named for the event is sent, with `WHATSAPP_PARAMS[event]` as its positional values).
 */
export const ORDER_EVENTS = [
  'ORDER_PLACED', 'PAYMENT_RECEIVED', 'PAYMENT_REMINDER', 'ABANDONED_CHECKOUT', 'ORDER_DISPATCHED', 'ORDER_DELIVERED',
  'ORDER_CANCELLED', 'REFUND_COMPLETED', 'TRANSFER_REPORTED', 'TRANSFER_NOT_FOUND',
] as const;
export type OrderEvent = (typeof ORDER_EVENTS)[number];

export interface OrderVars {
  customerName: string;
  storeName: string;
  orderReference: string;
  total: string; // formatted, e.g. ₦25,000
  link: string; // customer's private order page (pay, track)
  items: Array<{ name: string; quantity: number; lineTotal: string }>;
  holdUntil?: string | null;
  note?: string | null;
  refundAmount?: string | null;
  storeWhatsapp?: string | null;
}

/** Template values for each event, in order — the approved WhatsApp template must use {{1}}… in this order. */
export const WHATSAPP_PARAMS: Record<OrderEvent, Array<keyof OrderVars>> = {
  ORDER_PLACED: ['customerName', 'storeName', 'orderReference', 'total', 'link'],
  PAYMENT_RECEIVED: ['customerName', 'storeName', 'orderReference', 'total', 'link'],
  PAYMENT_REMINDER: ['customerName', 'storeName', 'orderReference', 'total', 'holdUntil', 'link'],
  ABANDONED_CHECKOUT: ['customerName', 'storeName', 'orderReference', 'total', 'link'],
  ORDER_DISPATCHED: ['customerName', 'storeName', 'orderReference', 'note', 'link'],
  ORDER_DELIVERED: ['customerName', 'storeName', 'orderReference', 'link'],
  ORDER_CANCELLED: ['customerName', 'storeName', 'orderReference', 'link'],
  REFUND_COMPLETED: ['customerName', 'storeName', 'orderReference', 'refundAmount', 'link'],
  TRANSFER_REPORTED: ['customerName', 'storeName', 'orderReference', 'link'],
  TRANSFER_NOT_FOUND: ['customerName', 'storeName', 'orderReference', 'link'],
};

export function whatsappParams(event: OrderEvent, v: OrderVars): string[] {
  return WHATSAPP_PARAMS[event].map((k) => {
    const x = v[k];
    return typeof x === 'string' && x.trim() ? x.trim() : '-';
  });
}

const first = (name: string) => name.trim().split(/\s+/)[0] || 'there';

/** Short text for SMS and WhatsApp free text. */
export function orderText(event: OrderEvent, v: OrderVars): string {
  const hi = `Hi ${first(v.customerName)},`;
  const s = v.storeName;
  switch (event) {
    case 'ORDER_PLACED': return `${hi} ${s} received your order ${v.orderReference} (${v.total}). Pay or track it here: ${v.link}`;
    case 'PAYMENT_RECEIVED': return `${hi} your payment of ${v.total} for order ${v.orderReference} at ${s} is confirmed. Thank you! Track it: ${v.link}`;
    case 'PAYMENT_REMINDER': return `${hi} order ${v.orderReference} (${v.total}) at ${s} is waiting for payment${v.holdUntil ? `; your items are held until ${v.holdUntil}` : ''}. Pay here: ${v.link}`;
    case 'ABANDONED_CHECKOUT': return `${hi} you left order ${v.orderReference} (${v.total}) at ${s} unpaid. Finish paying here: ${v.link}`;
    case 'ORDER_DISPATCHED': return `${hi} ${s} has sent out order ${v.orderReference}${v.note ? ` (${v.note})` : ''}. Track it: ${v.link}`;
    case 'ORDER_DELIVERED': return `${hi} order ${v.orderReference} from ${s} is marked delivered. Thank you for shopping! ${v.link}`;
    case 'ORDER_CANCELLED': return `${hi} order ${v.orderReference} at ${s} was cancelled${v.note ? `: ${v.note}` : ''}. Message the seller if you still want it. ${v.link}`;
    case 'REFUND_COMPLETED': return `${hi} ${s} refunded ${v.refundAmount ?? 'your payment'} for order ${v.orderReference}. Banks can take a few days to show it. ${v.link}`;
    case 'TRANSFER_REPORTED': return `${hi} thanks — ${s} will check its bank for your transfer for order ${v.orderReference} and confirm. ${v.link}`;
    case 'TRANSFER_NOT_FOUND': return `${hi} ${s} could not find your transfer for order ${v.orderReference}${v.note ? ` (${v.note})` : ''}. Please check and report it again: ${v.link}`;
  }
}

const SUBJECT: Record<OrderEvent, (v: OrderVars) => string> = {
  ORDER_PLACED: (v) => `Your order ${v.orderReference} at ${v.storeName}`,
  PAYMENT_RECEIVED: (v) => `Receipt: order ${v.orderReference} is paid`,
  PAYMENT_REMINDER: (v) => `Order ${v.orderReference} is waiting for payment`,
  ABANDONED_CHECKOUT: (v) => `Finish your order at ${v.storeName}`,
  ORDER_DISPATCHED: (v) => `Order ${v.orderReference} is on its way`,
  ORDER_DELIVERED: (v) => `Order ${v.orderReference} delivered`,
  ORDER_CANCELLED: (v) => `Order ${v.orderReference} was cancelled`,
  REFUND_COMPLETED: (v) => `Refund for order ${v.orderReference}`,
  TRANSFER_REPORTED: (v) => `We received your transfer report for ${v.orderReference}`,
  TRANSFER_NOT_FOUND: (v) => `Transfer for ${v.orderReference} not found`,
};

/** Email: receipt when paid, invoice when placed; other events a short note. */
export function orderEmail(event: OrderEvent, v: OrderVars): { subject: string; html: string } {
  const rows = v.items.map((i) => `<tr><td style="padding:6px 0">${i.quantity} × ${escapeHtml(i.name)}</td><td style="padding:6px 0;text-align:right">${escapeHtml(i.lineTotal)}</td></tr>`).join('');
  const table = `<table role="presentation" width="100%" style="border-collapse:collapse;margin:12px 0;font-size:14px">${rows}<tr><td style="padding:8px 0;border-top:1px solid #e3e6e4;font-weight:700">Total</td><td style="padding:8px 0;border-top:1px solid #e3e6e4;text-align:right;font-weight:700">${escapeHtml(v.total)}</td></tr></table>`;
  const heading = event === 'PAYMENT_RECEIVED' ? `Receipt — ${v.orderReference}` : event === 'ORDER_PLACED' ? `Invoice — ${v.orderReference}` : SUBJECT[event](v);
  const showItems = event === 'PAYMENT_RECEIVED' || event === 'ORDER_PLACED' || event === 'PAYMENT_REMINDER' || event === 'ABANDONED_CHECKOUT';
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f6;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#17201b">
<table role="presentation" width="100%"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px"><tr><td>
<p style="font-weight:700;color:#0e7a4d;margin:0 0 16px">${escapeHtml(v.storeName)}</p>
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(heading)}</h1>
<p style="line-height:1.55">${escapeHtml(orderText(event, { ...v, link: '' }).replace(/\s*(here|it)?:?\s*$/i, '.'))}</p>
${showItems ? table : ''}
<p style="margin:24px 0"><a href="${escapeHtml(v.link)}" style="background:#0e7a4d;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${event === 'PAYMENT_REMINDER' || event === 'ABANDONED_CHECKOUT' || event === 'ORDER_PLACED' ? 'Pay or view your order' : 'View your order'}</a></p>
<p style="color:#98a19c;font-size:12px">Sent by LiveSell Africa for ${escapeHtml(v.storeName)}. This link is private to you.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject: SUBJECT[event](v), html };
}
