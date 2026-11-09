import { ORDER_EVENTS, OrderEvent } from '../notifications/order-templates';

/**
 * A store's choices for automatic customer messages (pure, unit-tested). WhatsApp goes only to customers who opted
 * in and haven't replied STOP; SMS is the fallback when WhatsApp can't be used; email goes in addition when the
 * customer gave an address.
 */
export interface EventChannels { whatsapp: boolean; sms: boolean; email: boolean }
export interface Preferences {
  enabled: boolean;
  events: Record<OrderEvent, EventChannels>;
  /** Payment reminder this many hours before an unpaid order's stock hold ends (0 = off). */
  paymentReminderHoursBefore: number;
  /** Abandoned-checkout nudge this many minutes after an online order is placed unpaid (0 = off). */
  abandonedAfterMinutes: number;
}

const on = (email = false): EventChannels => ({ whatsapp: true, sms: true, email });

export const DEFAULT_PREFERENCES: Preferences = {
  enabled: true,
  events: {
    ORDER_PLACED: on(true), // invoice by email
    PAYMENT_RECEIVED: on(true), // receipt by email
    PAYMENT_REMINDER: on(),
    ABANDONED_CHECKOUT: on(),
    ORDER_DISPATCHED: on(),
    ORDER_DELIVERED: on(),
    ORDER_CANCELLED: on(),
    REFUND_COMPLETED: on(true),
    TRANSFER_REPORTED: { whatsapp: true, sms: false, email: false },
    TRANSFER_NOT_FOUND: on(),
  },
  paymentReminderHoursBefore: 6,
  abandonedAfterMinutes: 60,
};

/** Stored settings over the defaults; unknown keys are ignored, wrong types fall back to the default. */
export function mergePreferences(stored: unknown): Preferences {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<Preferences> & { events?: Record<string, Partial<EventChannels>> };
  const events = { ...DEFAULT_PREFERENCES.events };
  for (const e of ORDER_EVENTS) {
    const x = s.events?.[e];
    if (x && typeof x === 'object') {
      events[e] = {
        whatsapp: typeof x.whatsapp === 'boolean' ? x.whatsapp : events[e].whatsapp,
        sms: typeof x.sms === 'boolean' ? x.sms : events[e].sms,
        email: typeof x.email === 'boolean' ? x.email : events[e].email,
      };
    }
  }
  const int = (v: unknown, d: number, max: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : d);
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_PREFERENCES.enabled,
    events,
    paymentReminderHoursBefore: int(s.paymentReminderHoursBefore, DEFAULT_PREFERENCES.paymentReminderHoursBefore, 72),
    abandonedAfterMinutes: int(s.abandonedAfterMinutes, DEFAULT_PREFERENCES.abandonedAfterMinutes, 24 * 60),
  };
}

export interface Recipient {
  phone: string | null;
  email: string | null;
  whatsappOptIn: boolean;
  whatsappOptedOut: boolean;
  smsOptOut: boolean;
}

export interface ChannelPlan {
  whatsapp: 'text' | 'template' | null;
  sms: boolean;
  email: boolean;
  skipped: string[]; // why a channel was not used (for the order's message log)
}

/**
 * Which channels to use for one event. `inWindow` = the customer wrote to the platform number in the last 24 h (free
 * text allowed); `hasTemplate` = an approved template is mapped to this event; `enabled` = the platform channel works.
 */
export function planChannels(event: OrderEvent, prefs: Preferences, r: Recipient, ctx: { inWindow: boolean; hasTemplate: boolean; enabled: { WHATSAPP: boolean; SMS: boolean; EMAIL: boolean } }): ChannelPlan {
  const plan: ChannelPlan = { whatsapp: null, sms: false, email: false, skipped: [] };
  if (!prefs.enabled) return { ...plan, skipped: ['store has automatic messages off'] };
  const want = prefs.events[event];
  if (want.whatsapp) {
    if (!r.phone) plan.skipped.push('whatsapp: no phone');
    else if (r.whatsappOptedOut) plan.skipped.push('whatsapp: customer opted out');
    else if (!r.whatsappOptIn) plan.skipped.push('whatsapp: customer has not opted in');
    else if (!ctx.enabled.WHATSAPP) plan.skipped.push('whatsapp: not available');
    else if (ctx.inWindow) plan.whatsapp = 'text';
    else if (ctx.hasTemplate) plan.whatsapp = 'template';
    else plan.skipped.push('whatsapp: outside the 24-hour window and no approved template');
  }
  if (want.sms && !plan.whatsapp) {
    if (!r.phone) plan.skipped.push('sms: no phone');
    else if (r.smsOptOut) plan.skipped.push('sms: customer opted out');
    else if (!ctx.enabled.SMS) plan.skipped.push('sms: not available');
    else plan.sms = true;
  }
  if (want.email) {
    if (!r.email) plan.skipped.push('email: no address');
    else if (!ctx.enabled.EMAIL) plan.skipped.push('email: not available');
    else plan.email = true;
  }
  return plan;
}
