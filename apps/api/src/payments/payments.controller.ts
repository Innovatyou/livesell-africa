import { Body, Controller, Get, Headers, HttpCode, Injectable, NotFoundException, PipeTransform, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  AllowInactiveSubscription, CurrentTenant, CurrentUser, Public, RequirePermissions, RequirePlatformRole,
} from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import type { PaymentProviderCode } from '../generated/prisma/client';
import {
  ConnectDirectDto, ConnectSplitDto, PayOrderDto, RefundDto, SetActiveDto, TransactionsQuery, UpdateProviderDto, VerifyReferenceDto,
} from './payments.dto';
import { PaymentsService } from './payments.service';

type RawRequest = Request & { rawBody?: Buffer };
const PROVIDER_CODES: PaymentProviderCode[] = ['PAYSTACK', 'FLUTTERWAVE', 'BACHS', 'BANK_TRANSFER'];
/** Online providers a seller can connect (path segment: paystack | flutterwave | bachs). */
const ONLINE: PaymentProviderCode[] = ['PAYSTACK', 'FLUTTERWAVE', 'BACHS'];

@Injectable()
export class ProviderParamPipe implements PipeTransform<string, PaymentProviderCode> {
  transform(value: string) {
    const c = ONLINE.find((v) => v === String(value).toUpperCase());
    if (!c) throw new NotFoundException('Unknown payment provider');
    return c;
  }
}
const PROVIDER_PARAM = { name: 'provider', enum: ['paystack', 'flutterwave', 'bachs'] };

@ApiTags('payments (seller)')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ version: '1' })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @RequirePermissions('orders:create') @Post('orders/:id/payment-link') @HttpCode(200)
  @ApiOperation({ summary: 'Create (or reuse) a Paystack checkout link for an order awaiting payment, to send to the customer' })
  link(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PayOrderDto) {
    return this.payments.startOrderPayment(t.tenantId, id, { email: dto.email, actorId: u.id, via: 'staff' });
  }

  @RequirePermissions('orders:read') @Post('orders/:id/payments/verify') @HttpCode(200)
  @ApiOperation({ summary: "Check the order's open payments with Paystack now (server-side verification)" })
  verifyOrder(@CurrentTenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.verifyOrder(t.tenantId, id);
  }

  @AllowInactiveSubscription() @RequirePermissions('payments:refund') @Post('orders/:id/refunds')
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Repeat-safe key; the same key never refunds twice' })
  @ApiOperation({ summary: 'Refund a verified payment in full or in part (§26 #12)' })
  refund(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundDto, @Headers('idempotency-key') key?: string) {
    const k = key && /^[A-Za-z0-9_-]{8,80}$/.test(key) ? key : undefined;
    return this.payments.refund(t.tenantId, u.id, id, dto, k);
  }

  @RequirePermissions('payments:read') @Get('payments/transactions')
  @ApiOperation({ summary: 'Order payment transactions with fees, commission and proceeds' })
  transactions(@CurrentTenant() t: TenantContext, @Query() q: TransactionsQuery) {
    return this.payments.listTransactions(t.tenantId, q);
  }

  @RequirePermissions('payments:read') @Get('payments/settings')
  @ApiOperation({ summary: 'Every provider with this store’s connection, the default provider and commission (secrets are never returned)' })
  settings(@CurrentTenant() t: TenantContext) {
    return this.payments.settings(t.tenantId);
  }

  @RequirePermissions('payments:configure') @Put('payments/settings/:provider/direct') @ApiParam(PROVIDER_PARAM)
  @ApiOperation({ summary: "Connect the seller's own provider account (key validated with the provider, stored encrypted)" })
  direct(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('provider', ProviderParamPipe) code: PaymentProviderCode, @Body() dto: ConnectDirectDto, @Req() req: Request) {
    return this.payments.connectDirect(t.tenantId, u.id, code, dto, req.ip);
  }

  @RequirePermissions('payments:configure') @Put('payments/settings/:provider/split') @ApiParam(PROVIDER_PARAM)
  @ApiOperation({ summary: 'Get paid through LiveSell: a provider subaccount that settles to your bank account (Paystack, Flutterwave)' })
  split(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('provider', ProviderParamPipe) code: PaymentProviderCode, @Body() dto: ConnectSplitDto, @Req() req: Request) {
    return this.payments.connectSplit(t.tenantId, u.id, code, dto, req.ip);
  }

  @RequirePermissions('payments:configure') @Post('payments/settings/:provider/active') @HttpCode(200) @ApiParam(PROVIDER_PARAM)
  @ApiOperation({ summary: 'Turn a connected provider on or off for this store' })
  active(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('provider', ProviderParamPipe) code: PaymentProviderCode, @Body() dto: SetActiveDto) {
    return this.payments.setActive(t.tenantId, u.id, code, dto.isActive);
  }

  @RequirePermissions('payments:configure') @Post('payments/settings/:provider/default') @HttpCode(200) @ApiParam(PROVIDER_PARAM)
  @ApiOperation({ summary: 'Make this provider the one customers pay with' })
  makeDefault(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('provider', ProviderParamPipe) code: PaymentProviderCode) {
    return this.payments.setDefault(t.tenantId, u.id, code);
  }

  @RequirePermissions('payments:configure') @Get('payments/banks')
  @ApiOperation({ summary: 'Nigerian banks for the settlement account form (?provider=paystack|flutterwave)' })
  banks(@Query('provider') provider?: string) {
    return this.payments.banks(new ProviderParamPipe().transform(provider ?? 'paystack'));
  }

  @AllowInactiveSubscription() @RequirePermissions('billing:manage') @Post('billing/invoices/:id/pay') @HttpCode(200)
  @ApiOperation({ summary: 'Pay an open subscription invoice online (Paystack checkout link)' })
  payInvoice(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.startInvoicePayment(t.tenantId, u.id, id);
  }
}

@ApiTags('payments (public)')
@Controller({ path: 'payments', version: '1' })
export class PaymentsPublicController {
  constructor(private readonly payments: PaymentsService) {}

  @Public() @Throttle({ default: { limit: Number(process.env.PAYMENT_VERIFY_LIMIT ?? 30), ttl: 60_000 } }) @Post('verify') @HttpCode(200)
  @ApiOperation({ summary: 'After the provider redirect: verify the payment server-side and report its status' })
  verify(@Body() dto: VerifyReferenceDto) {
    return this.payments.publicStatus(dto.reference);
  }

  @Public() @Post(':provider/webhook') @HttpCode(200) @ApiExcludeEndpoint()
  platformWebhook(@Param('provider', ProviderParamPipe) code: PaymentProviderCode, @Req() req: RawRequest, @Headers() headers: Record<string, string>) {
    return this.payments.handleWebhook(code, null, req.rawBody, headers);
  }

  @Public() @Post(':provider/webhook/:accountId') @HttpCode(200) @ApiExcludeEndpoint()
  sellerWebhook(@Param('provider', ProviderParamPipe) code: PaymentProviderCode, @Param('accountId', ParseUUIDPipe) accountId: string, @Req() req: RawRequest, @Headers() headers: Record<string, string>) {
    return this.payments.handleWebhook(code, accountId, req.rawBody, headers);
  }
}

@ApiTags('admin: payment providers')
@ApiBearerAuth()
@RequirePlatformRole('PLATFORM_ADMIN')
@Controller({ path: 'admin/payment-providers', version: '1' })
export class AdminPaymentProvidersController {
  constructor(private readonly payments: PaymentsService) {}

  @Get() @ApiOperation({ summary: 'Payment providers, whether an adapter exists and whether the platform key is configured' })
  list() {
    return this.payments.listProviders();
  }

  @Patch(':code') @ApiOperation({ summary: 'Enable/disable a provider (only providers with an adapter can be enabled)' })
  update(@CurrentUser() u: AuthUser, @Param('code') code: string, @Body() dto: UpdateProviderDto) {
    const c = PROVIDER_CODES.find((v) => v === code.toUpperCase());
    if (!c) throw new NotFoundException('Unknown payment provider');
    return this.payments.updateProvider(u.id, c, dto);
  }
}
