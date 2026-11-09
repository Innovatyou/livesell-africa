import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AllowInactiveSubscription, CurrentTenant, CurrentUser, RequirePermissions, RequirePlatformRole } from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { BankTransferService } from './bank-transfer.service';
import { CreateTransferAccountDto, ReceiptUploadDto, RejectTransferDto, TransferClaimDto, UpdateTransferAccountDto, VerifyTransferDto } from './payments.dto';
import { ReconciliationService } from './reconciliation.service';

@ApiTags('payments: bank transfer (seller)')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ version: '1' })
export class BankTransferController {
  constructor(private readonly transfers: BankTransferService, private readonly recon: ReconciliationService) {}

  // ── Accounts customers transfer to (§13) ──
  @RequirePermissions('payments:read') @Get('payments/bank-accounts')
  @ApiOperation({ summary: 'Bank accounts shown to customers for transfers' })
  accounts(@CurrentTenant() t: TenantContext) {
    return this.transfers.listAccounts(t.tenantId);
  }

  @RequirePermissions('payments:configure') @Post('payments/bank-accounts')
  @ApiOperation({ summary: 'Add a bank account for transfers (the name is confirmed with the bank when possible; stored encrypted)' })
  addAccount(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: CreateTransferAccountDto, @Req() req: Request) {
    return this.transfers.createAccount(t.tenantId, u.id, dto, req.ip);
  }

  @RequirePermissions('payments:configure') @Patch('payments/bank-accounts/:id')
  @ApiOperation({ summary: 'Change instructions, switch off, or make default' })
  updateAccount(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTransferAccountDto) {
    return this.transfers.updateAccount(t.tenantId, u.id, id, dto);
  }

  @RequirePermissions('payments:configure') @Delete('payments/bank-accounts/:id')
  @ApiOperation({ summary: 'Remove a transfer account' })
  removeAccount(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.removeAccount(t.tenantId, u.id, id);
  }

  // ── Transfers on orders ──
  @RequirePermissions('payments:read') @Get('payments/transfers/pending')
  @ApiOperation({ summary: 'Reported transfers waiting to be checked, oldest first' })
  pending(@CurrentTenant() t: TenantContext) {
    return this.transfers.pending(t.tenantId);
  }

  @RequirePermissions('orders:create') @Post('orders/:id/transfers/receipt-url')
  @ApiOperation({ summary: 'Presigned PUT for a transfer receipt (PNG/JPG/WebP/PDF ≤ 5 MB), private' })
  receiptUpload(@CurrentTenant() t: TenantContext, @Body() dto: ReceiptUploadDto) {
    return this.transfers.presignReceipt(t.tenantId, dto.contentType, dto.contentLength);
  }

  @RequirePermissions('orders:create') @Post('orders/:id/transfers')
  @ApiOperation({ summary: 'Record a transfer the customer says they made (e.g. by phone). It still has to be verified.' })
  record(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferClaimDto) {
    return this.transfers.claim(t.tenantId, id, dto, { actorId: u.id, via: 'staff' });
  }

  @AllowInactiveSubscription() @RequirePermissions('payments:verify_transfer') @Post('orders/:id/transfers/:txnId/verify') @HttpCode(200)
  @ApiOperation({ summary: 'Confirm the money is in your bank account: the order becomes paid (amount must equal the order total)' })
  verify(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('txnId', ParseUUIDPipe) txnId: string, @Body() dto: VerifyTransferDto, @Req() req: Request) {
    return this.transfers.verify(t.tenantId, u.id, id, txnId, dto, req.ip);
  }

  @AllowInactiveSubscription() @RequirePermissions('payments:verify_transfer') @Post('orders/:id/transfers/:txnId/reject') @HttpCode(200)
  @ApiOperation({ summary: 'The transfer is not in your account: the order goes back to awaiting payment' })
  reject(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('txnId', ParseUUIDPipe) txnId: string, @Body() dto: RejectTransferDto, @Req() req: Request) {
    return this.transfers.reject(t.tenantId, u.id, id, txnId, dto, req.ip);
  }

  @RequirePermissions('payments:read') @Get('orders/:id/transfers/:txnId/receipt')
  @ApiOperation({ summary: 'Short-lived link to the uploaded receipt (evidence only, never proof of payment)' })
  receipt(@CurrentTenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('txnId', ParseUUIDPipe) txnId: string) {
    return this.transfers.receiptUrl(t.tenantId, id, txnId);
  }

  // ── Reconciliation ──
  @RequirePermissions('payments:read') @Get('payments/reconciliation')
  @ApiOperation({ summary: 'Checks payments, refunds, orders and the ledger against each other; lists what needs attention' })
  reconciliation(@CurrentTenant() t: TenantContext) {
    return this.recon.report(t.tenantId);
  }
}

@ApiTags('admin: payments')
@ApiBearerAuth()
@RequirePlatformRole('PLATFORM_ADMIN', 'PLATFORM_SUPPORT')
@Controller({ path: 'admin/payments', version: '1' })
export class AdminReconciliationController {
  constructor(private readonly recon: ReconciliationService) {}

  @Get('reconciliation') @ApiOperation({ summary: 'Stores with reconciliation issues, worst first' })
  report() {
    return this.recon.platformReport();
  }
}
