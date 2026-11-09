import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AuthMailer, StaffInvitationMessage } from '../auth/auth-mailer';
import { BillingNotifier, CommissionInvoiceMessage, ExpiredMessage, OverdueMessage, ReminderMessage } from '../billing/billing-notifier';
import { NotificationService } from './notifications.service';

/**
 * AuthMailer over Veltrix (bound when VELTRIX_ENABLED=true). Links and codes are secrets: rendered in memory,
 * sent once, never stored (the notification row keeps only type, destination and outcome). Platform-level
 * (tenantId null): auth messages are LiveSell's cost, not a seller's.
 */
@Injectable()
export class VeltrixAuthMailer extends AuthMailer {
  constructor(private readonly notifications: NotificationService) {
    super();
  }

  get canSendSms() {
    return this.notifications.channelEnabled('SMS');
  }

  async sendEmailVerification(to: string, name: string, token: string) {
    await this.notifications.send({ tenantId: null, channel: 'EMAIL', type: 'EMAIL_VERIFICATION', template: 'EMAIL_VERIFICATION', destination: to, toName: name, vars: { name, token }, secret: true });
  }

  async sendPasswordReset(to: string, name: string, token: string) {
    await this.notifications.send({ tenantId: null, channel: 'EMAIL', type: 'PASSWORD_RESET', template: 'PASSWORD_RESET', destination: to, toName: name, vars: { name, token }, secret: true });
  }

  async sendStaffInvitation(to: string, m: StaffInvitationMessage) {
    await this.notifications.send({ tenantId: null, channel: 'EMAIL', type: 'STAFF_INVITATION', template: 'STAFF_INVITATION', destination: to, vars: { ...m }, secret: true });
  }

  /** The caller is waiting for this code, so a failed send is reported instead of pretending it went out. */
  async sendPhoneOtp(toPhone: string, code: string) {
    const out = await this.notifications.send({ tenantId: null, channel: 'SMS', type: 'PHONE_OTP', template: 'PHONE_OTP', destination: toPhone, vars: { code }, secret: true });
    if (out.status === 'FAILED') {
      throw new ServiceUnavailableException({ code: 'SMS_NOT_SENT', message: 'We couldn’t send the code by SMS right now. Please try again in a few minutes.' });
    }
  }
}

/** BillingNotifier over Veltrix email: LiveSell's own billing messages (retried on outages, never seller-billed). */
@Injectable()
export class VeltrixBillingNotifier extends BillingNotifier {
  constructor(private readonly notifications: NotificationService) {
    super();
  }

  async sendRenewalReminder(to: string, m: ReminderMessage) {
    await this.notifications.send({ tenantId: null, channel: 'EMAIL', type: 'BILLING_REMINDER', template: 'BILLING_REMINDER', destination: to, vars: { ...m } });
  }

  async sendPaymentOverdue(to: string, m: OverdueMessage) {
    await this.notifications.send({ tenantId: null, channel: 'EMAIL', type: 'BILLING_OVERDUE', template: 'BILLING_OVERDUE', destination: to, vars: { ...m } });
  }

  async sendSubscriptionExpired(to: string, m: ExpiredMessage) {
    await this.notifications.send({ tenantId: null, channel: 'EMAIL', type: 'BILLING_EXPIRED', template: 'BILLING_EXPIRED', destination: to, vars: { ...m } });
  }

  async sendCommissionInvoice(to: string, m: CommissionInvoiceMessage) {
    await this.notifications.send({ tenantId: null, channel: 'EMAIL', type: 'COMMISSION_INVOICE', template: 'COMMISSION_INVOICE', destination: to, vars: { ...m }, dedupeKey: `commission-invoice:${m.invoiceNumber}` });
  }
}
