import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Observability (MASTER-SPEC §27 structured logging + error monitoring):
 *  - every request gets an `X-Request-Id` (kept from the proxy when well-formed) that is echoed back and logged;
 *  - 5xx errors are logged once as structured JSON with the request id (never the body, headers or secrets);
 *  - optionally, `ALERT_WEBHOOK_URL` (e.g. a Slack/Teams incoming webhook) gets a short alert, at most one per
 *    distinct error per 5 minutes, so an outage can't flood the channel.
 * Production logs are JSON lines (main.ts), ready for any log collector.
 */
export function requestId(req: Request & { id?: string }, res: Response, next: NextFunction) {
  const given = req.header('x-request-id');
  req.id = given && /^[A-Za-z0-9._-]{8,80}$/.test(given) ? given : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

const ALERT_EVERY_MS = 5 * 60_000;
const lastAlert = new Map<string, number>();

/** Pure: whether to send an alert for this error signature now (and remember it). */
export function shouldAlert(signature: string, now = Date.now(), seen = lastAlert): boolean {
  const last = seen.get(signature) ?? 0;
  if (now - last < ALERT_EVERY_MS) return false;
  seen.set(signature, now);
  if (seen.size > 500) seen.delete(seen.keys().next().value as string);
  return true;
}

@Catch()
export class ErrorReportingFilter extends BaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  override catch(exception: unknown, host: ArgumentsHost) {
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= 500 && host.getType() === 'http') {
      const req = host.switchToHttp().getRequest<Request & { id?: string; user?: { id?: string }; tenant?: { tenantId?: string } }>();
      const err = exception instanceof Error ? exception : new Error(String(exception));
      const route = `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`;
      this.logger.error({ msg: 'Request failed', requestId: req.id, route, status, error: err.name, message: err.message.slice(0, 500), userId: req.user?.id, tenantId: req.tenant?.tenantId, stack: err.stack?.split('\n').slice(0, 8).join('\n') });
      const url = process.env.ALERT_WEBHOOK_URL;
      if (url && shouldAlert(`${route}:${err.name}:${err.message.slice(0, 80)}`)) {
        void fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
          body: JSON.stringify({ text: `LiveSell ${process.env.NODE_ENV ?? ''} error ${status} on ${route}: ${err.name}: ${err.message.slice(0, 200)} (request ${req.id})` }),
        }).catch(() => undefined);
      }
    }
    super.catch(exception, host);
  }
}
