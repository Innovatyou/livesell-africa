/**
 * Message templates (pure, unit-tested). Every value is HTML-escaped; links are built from APP_URL only.
 * SMS texts stay within one or two segments; WhatsApp business-initiated messages need an approved template
 * on the platform number (Phase 9 registers the order templates), so here WhatsApp is only used for free text.
 */
export type TemplateKey =
  | 'EMAIL_VERIFICATION' | 'PASSWORD_RESET' | 'STAFF_INVITATION' | 'PHONE_OTP'
  | 'BILLING_REMINDER' | 'BILLING_OVERDUE' | 'BILLING_EXPIRED' | 'TEST_MESSAGE'
  // Phase 9: customer messages about an order (vars: { event, order }) and WhatsApp conversation replies (vars: { text }).
  | 'ORDER_EVENT' | 'WHATSAPP_REPLY'
  // Phase 10b: monthly commission invoice; scheduled analytics report (vars: see analytics-report.ts).
  | 'COMMISSION_INVOICE' | 'ANALYTICS_REPORT';

export interface Rendered { subject?: string; html?: string; text: string }

import { escapeHtml } from './html';
import { orderEmail, OrderEvent, orderText, OrderVars } from './order-templates';
import { analyticsReportEmail } from './analytics-report';

export { escapeHtml };

const date = (d: Date | string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' }).format(new Date(d));
const naira = (minor: bigint | string, currency = 'NGN') => {
  const v = BigInt(minor);
  const whole = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (v % 100n).toString().padStart(2, '0');
  return `${currency === 'NGN' ? '₦' : `${currency} `}${whole}${frac === '00' ? '' : `.${frac}`}`;
};

function layout(title: string, bodyHtml: string, cta?: { label: string; url: string }) {
  const button = cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(cta.url)}" style="background:#0e7a4d;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(cta.label)}</a></p>
       <p style="color:#6b7570;font-size:13px">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(cta.url)}</span></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f6f7f6;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#17201b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px" cellpadding="0" cellspacing="0"><tr><td>
<p style="font-weight:700;color:#0e7a4d;margin:0 0 16px">LiveSell Africa</p>
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>
${bodyHtml}${button}
<p style="color:#98a19c;font-size:12px;margin-top:28px">You received this because of activity on your LiveSell account. If this wasn't you, you can ignore it.</p>
</td></tr></table></td></tr></table></body></html>`;
}

const p = (s: string) => `<p style="line-height:1.55;margin:0 0 12px">${s}</p>`;

/** vars are plain values; secrets (token, code) are only ever passed in memory and never stored. */
export function render(key: TemplateKey, vars: Record<string, unknown>, appUrl: string): Rendered {
  const v = (k: string) => escapeHtml(vars[k]);
  const link = (path: string, token: unknown) => `${appUrl}${path}?token=${encodeURIComponent(String(token))}`;
  switch (key) {
    case 'EMAIL_VERIFICATION': {
      const url = link('/verify-email', vars.token);
      return {
        subject: 'Confirm your email address',
        html: layout('Confirm your email', p(`Hello ${v('name')},`) + p('Please confirm your email address to finish setting up your LiveSell account. The link works for 24 hours.'), { label: 'Confirm email', url }),
        text: `Confirm your LiveSell email: ${url}`,
      };
    }
    case 'PASSWORD_RESET': {
      const url = link('/reset-password', vars.token);
      return {
        subject: 'Reset your LiveSell password',
        html: layout('Reset your password', p(`Hello ${v('name')},`) + p('Someone asked to reset the password for your LiveSell account. The link works for one hour and can be used once.'), { label: 'Choose a new password', url }),
        text: `Reset your LiveSell password: ${url}`,
      };
    }
    case 'STAFF_INVITATION': {
      const url = link('/invite', vars.token);
      return {
        subject: `${String(vars.businessName ?? '')} invited you to LiveSell`,
        html: layout(`Join ${String(vars.businessName ?? '')} on LiveSell`, p(`${v('inviterName')} invited you to help run <strong>${v('businessName')}</strong> as <strong>${v('roleName')}</strong>.`) + p(`The invitation expires on ${escapeHtml(date(vars.expiresAt as Date))}.`), { label: 'Accept invitation', url }),
        text: `${String(vars.inviterName)} invited you to ${String(vars.businessName)} on LiveSell: ${url}`,
      };
    }
    case 'PHONE_OTP':
      return { text: `Your LiveSell code is ${String(vars.code)}. It expires in 10 minutes. Never share it with anyone.` };
    case 'BILLING_REMINDER': {
      const trial = vars.kind === 'trial_ending';
      const days = Number(vars.daysLeft);
      const when = `${days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`} (${date(vars.endsAt as Date)})`;
      const commission = vars.pricingModel === 'COMMISSION' && vars.commissionBps != null ? ` After that, ${(Number(vars.commissionBps) / 100).toString()}% of each verified sale is charged instead of a monthly fee.` : '';
      return {
        subject: trial ? `Your free trial ends ${days <= 1 ? (days <= 0 ? 'today' : 'tomorrow') : `in ${days} days`}` : `Your ${String(vars.planName)} plan renews soon`,
        html: layout(trial ? 'Your free trial is ending' : 'Your plan renews soon', p(`Hello ${v('businessName')},`) + p(`${trial ? 'Your free trial of' : 'Your'} <strong>${v('planName')}</strong> ${trial ? 'ends' : 'renews'} ${escapeHtml(when)}.${escapeHtml(commission)}`), { label: 'View plan & billing', url: `${appUrl}/settings/billing` }),
        text: `LiveSell: your ${trial ? 'trial' : String(vars.planName)} ends ${when}.`,
      };
    }
    case 'BILLING_OVERDUE':
      return {
        subject: `Payment due: invoice ${String(vars.invoiceNumber)}`,
        html: layout('Your LiveSell payment is due', p(`Hello ${v('businessName')},`) + p(`Invoice <strong>${v('invoiceNumber')}</strong> for ${escapeHtml(naira(vars.amountMinor as bigint, String(vars.currency ?? 'NGN')))} (${v('planName')}) is due. Your store stays open until ${escapeHtml(date(vars.accessEndsAt as Date))}.`), { label: 'Pay now', url: `${appUrl}/settings/billing` }),
        text: `LiveSell: invoice ${String(vars.invoiceNumber)} is due. Pay before ${date(vars.accessEndsAt as Date)} to keep your store open.`,
      };
    case 'BILLING_EXPIRED':
      return {
        subject: 'Your LiveSell subscription has ended',
        html: layout('Your subscription has ended', p(`Hello ${v('businessName')},`) + p(`Your <strong>${v('planName')}</strong> subscription has ended, so your store is paused. Your products, orders and customers are kept — choose a plan to reopen.`), { label: 'Reopen my store', url: `${appUrl}/settings/billing` }),
        text: 'LiveSell: your subscription has ended and your store is paused. Choose a plan to reopen it.',
      };
    case 'ORDER_EVENT': {
      const e = vars.event as OrderEvent;
      const o = vars.order as OrderVars;
      const m = orderEmail(e, o);
      return { subject: m.subject, html: m.html, text: orderText(e, o) };
    }
    case 'COMMISSION_INVOICE': {
      const amount = naira(vars.amountMinor as bigint | string, String(vars.currency ?? 'NGN'));
      const due = date(vars.dueAt as Date);
      return {
        subject: `LiveSell commission invoice ${String(vars.invoiceNumber ?? '')}`,
        html: layout('Your commission invoice', p(`Hello ${v('businessName')},`) + p(`Commission on the sales you collected directly (your own payment account or bank transfers) up to the end of <strong>${v('periodLabel')}</strong> comes to <strong>${escapeHtml(amount)}</strong>.`) + p(`Please pay invoice ${v('invoiceNumber')} by <strong>${escapeHtml(due)}</strong>. Split payments were already settled automatically.`), { label: 'Pay invoice', url: `${appUrl}/settings/billing` }),
        text: `LiveSell: commission invoice ${String(vars.invoiceNumber ?? '')} for ${amount}, due ${due}. Pay at ${appUrl}/settings/billing`,
      };
    }
    case 'ANALYTICS_REPORT':
      return analyticsReportEmail(vars, appUrl);
    case 'WHATSAPP_REPLY':
      return { text: String(vars.text ?? '') };
    case 'TEST_MESSAGE':
      return { subject: 'LiveSell test message', html: layout('Test message', p('This is a test from LiveSell Africa. Messaging through Veltrix is working.')), text: 'LiveSell test message: messaging through Veltrix is working.' };
  }
}
