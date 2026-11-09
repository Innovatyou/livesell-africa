import { Injectable, Logger } from '@nestjs/common';

export interface ReminderMessage {
  businessName: string;
  planName: string;
  endsAt: Date;
  daysLeft: number;
  kind: 'trial_ending' | 'renewal_due';
  /** After the trial, commission plans charge a share of verified sales instead of a fixed fee. */
  pricingModel: 'SUBSCRIPTION' | 'COMMISSION';
  commissionBps: number | null;
}

export interface OverdueMessage {
  businessName: string;
  planName: string;
  invoiceNumber: string;
  amountMinor: bigint;
  currency: string;
  accessEndsAt: Date;
}

export interface CommissionInvoiceMessage {
  businessName: string;
  invoiceNumber: string;
  amountMinor: bigint;
  currency: string;
  periodLabel: string; // "October 2026"
  dueAt: Date;
}

export interface ExpiredMessage {
  businessName: string;
  planName: string;
}

/** Port for SaaS billing emails. Phase 8 binds it to the Veltrix email adapter. */
export abstract class BillingNotifier {
  abstract sendRenewalReminder(to: string, m: ReminderMessage): Promise<void>;
  abstract sendPaymentOverdue(to: string, m: OverdueMessage): Promise<void>;
  abstract sendSubscriptionExpired(to: string, m: ExpiredMessage): Promise<void>;
  abstract sendCommissionInvoice(to: string, m: CommissionInvoiceMessage): Promise<void>;
}

@Injectable()
export class LogBillingNotifier extends BillingNotifier {
  private readonly logger = new Logger('BillingNotifier');
  private readonly enabled = process.env.NODE_ENV !== 'production';

  private out(msg: string) {
    if (this.enabled) this.logger.log(`[dev] ${msg}`);
    else this.logger.warn(`Email provider not configured; not sent: ${msg.split(':')[0]}`);
  }
  async sendRenewalReminder(to: string, m: ReminderMessage) {
    this.out(`${m.kind} reminder to ${to}: ${m.planName} ends ${m.endsAt.toISOString()} (${m.daysLeft}d)`);
  }
  async sendPaymentOverdue(to: string, m: OverdueMessage) {
    this.out(`overdue notice to ${to}: invoice ${m.invoiceNumber}, access ends ${m.accessEndsAt.toISOString()}`);
  }
  async sendSubscriptionExpired(to: string, m: ExpiredMessage) {
    this.out(`expiry notice to ${to}: ${m.planName}`);
  }
  async sendCommissionInvoice(to: string, m: CommissionInvoiceMessage) {
    this.out(`commission invoice to ${to}: ${m.invoiceNumber} ${m.amountMinor} ${m.currency} for ${m.periodLabel}, due ${m.dueAt.toISOString()}`);
  }
}
