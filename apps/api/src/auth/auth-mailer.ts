import { Injectable, Logger } from '@nestjs/common';

export interface StaffInvitationMessage {
  businessName: string;
  inviterName: string;
  roleName: string;
  token: string;
  expiresAt: Date;
}

/**
 * Port for auth-related messages (email + SMS). Phase 8 binds this to the Veltrix adapter.
 * Tokens and codes are passed in memory only — never persisted in plaintext.
 * `canSendSms` lets callers fail honestly instead of pretending an OTP went out.
 */
export abstract class AuthMailer {
  abstract readonly canSendSms: boolean;
  abstract sendEmailVerification(to: string, name: string, token: string): Promise<void>;
  abstract sendPasswordReset(to: string, name: string, token: string): Promise<void>;
  abstract sendStaffInvitation(to: string, message: StaffInvitationMessage): Promise<void>;
  abstract sendPhoneOtp(toPhone: string, code: string): Promise<void>;
}

/** Development adapter: logs links/codes. In production it sends nothing until Veltrix is configured. */
@Injectable()
export class LogAuthMailer extends AuthMailer {
  private readonly logger = new Logger('AuthMailer');
  private readonly enabled = process.env.NODE_ENV !== 'production';
  readonly canSendSms = this.enabled;

  async sendEmailVerification(to: string, _name: string, token: string) {
    if (this.enabled) this.logger.log(`[dev] verify ${to}: /verify-email?token=${token}`);
    else this.logger.warn(`Email provider not configured; verification for ${to} not sent`);
  }
  async sendPasswordReset(to: string, _name: string, token: string) {
    if (this.enabled) this.logger.log(`[dev] reset ${to}: /reset-password?token=${token}`);
    else this.logger.warn(`Email provider not configured; reset for ${to} not sent`);
  }
  async sendStaffInvitation(to: string, m: StaffInvitationMessage) {
    if (this.enabled) this.logger.log(`[dev] invite ${to} to ${m.businessName} as ${m.roleName}: /invite?token=${m.token}`);
    else this.logger.warn(`Email provider not configured; invitation for ${to} not sent`);
  }
  async sendPhoneOtp(toPhone: string, code: string) {
    if (this.enabled) this.logger.log(`[dev] OTP for ${toPhone.slice(0, -4)}****: ${code}`);
    else this.logger.warn('SMS provider not configured; OTP not sent');
  }
}
