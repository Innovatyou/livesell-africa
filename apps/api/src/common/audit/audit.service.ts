import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEvent {
  action: string;
  actorId?: string | null;
  tenantId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

const REDACT_CONTAINS = /password|passwd|secret|token|api_?key|private_?key|cvv|card_?number|account_?number/i;
const REDACT_EXACT = /^(pass|pin|pan|key|otp)$/i;
const shouldRedact = (k: string) => REDACT_CONTAINS.test(k) || REDACT_EXACT.test(k);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shouldRedact(k) ? '[REDACTED]' : redact(v)]));
  }
  return value;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** Audit writes must never break the business operation, but failures are logged loudly. */
  async record(event: AuditEvent): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: event.action,
          actorId: event.actorId ?? null,
          tenantId: event.tenantId ?? null,
          entityType: event.entityType,
          entityId: event.entityId,
          metadata: (redact(event.metadata ?? {}) as object) ?? {},
          ip: event.ip,
          userAgent: event.userAgent?.slice(0, 512),
        },
      });
    } catch (err) {
      this.logger.error(`Audit write failed for ${event.action}: ${(err as Error).message}`);
    }
  }
}
