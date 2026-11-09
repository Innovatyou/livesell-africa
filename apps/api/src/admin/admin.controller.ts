import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDefined, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, RequirePlatformRole } from '../common/auth/decorators';
import type { AuthUser } from '../common/auth/request-context';
import { AdminService } from './admin.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const bool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

class PageQuery {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}
export class SellersQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'TRIAL', 'SUSPENDED', 'CLOSED'] }) @IsOptional() @IsIn(['ACTIVE', 'TRIAL', 'SUSPENDED', 'CLOSED']) status?: 'ACTIVE' | 'TRIAL' | 'SUSPENDED' | 'CLOSED';
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
export class ReasonDto {
  @ApiProperty({ example: 'Repeated customer complaints; under review' }) @Transform(trim) @IsString() @Length(5, 300) reason!: string;
}
export class NoteDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
}
export class CommissionQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['OPEN', 'PAID', 'UNCOLLECTIBLE'] }) @IsOptional() @IsIn(['OPEN', 'PAID', 'UNCOLLECTIBLE']) status?: 'OPEN' | 'PAID' | 'UNCOLLECTIBLE';
}
export class WebhooksQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['FAILED', 'IGNORED', 'PROCESSED', 'RECEIVED'] }) @IsOptional() @IsIn(['FAILED', 'IGNORED', 'PROCESSED', 'RECEIVED']) status?: 'FAILED' | 'IGNORED' | 'PROCESSED' | 'RECEIVED';
  @ApiPropertyOptional() @IsOptional() @Transform(bool) @IsBoolean() invalidOnly?: boolean;
}
export class AuditQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() tenantId?: string;
  @ApiPropertyOptional({ example: 'payment.' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(60) action?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() actorId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(bool) @IsBoolean() platformOnly?: boolean;
}
export class SettingDto {
  @ApiProperty({ description: 'New value (number or array, depending on the setting)' }) @IsDefined() value!: unknown;
}

/** MASTER-SPEC §21 super-admin portal. Support staff can look; only platform admins change anything. */
@ApiTags('admin: platform')
@ApiBearerAuth()
@RequirePlatformRole('PLATFORM_ADMIN', 'PLATFORM_SUPPORT')
@Controller({ path: 'admin', version: '1' })
export class AdminPortalController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview') @ApiOperation({ summary: 'Sellers, orders, volume, revenue, commission, gateways, subscriptions, messaging, top sellers, problems, health' })
  overview() {
    return this.admin.overview();
  }

  @Get('sellers') @ApiOperation({ summary: 'Sellers with plan and activity' })
  sellers(@Query() q: SellersQuery) {
    return this.admin.sellers(q);
  }

  @Get('sellers/:id') @ApiOperation({ summary: 'One seller: subscription, team, sales, invoices, commission, recent activity' })
  seller(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.seller(id);
  }

  @RequirePlatformRole('PLATFORM_ADMIN') @Post('sellers/:id/suspend') @HttpCode(200)
  @ApiOperation({ summary: 'Suspend a seller (store, storefront and team blocked at once; data kept)' })
  suspend(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.admin.suspend(u.id, id, dto.reason);
  }

  @RequirePlatformRole('PLATFORM_ADMIN') @Post('sellers/:id/reactivate') @HttpCode(200)
  @ApiOperation({ summary: 'Lift a suspension' })
  reactivate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto) {
    return this.admin.reactivate(u.id, id, dto.note);
  }

  @Get('commission') @ApiOperation({ summary: 'Commission invoices across sellers, with the open total' })
  commission(@Query() q: CommissionQuery) {
    return this.admin.commissionInvoices(q);
  }

  @RequirePlatformRole('PLATFORM_ADMIN') @Post('commission/invoices/:id/waive') @HttpCode(200)
  @ApiOperation({ summary: 'Write off an open commission invoice (ledger reversed, write-block lifted)' })
  waive(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.admin.waiveCommission(u.id, id, dto.reason);
  }

  @Get('webhooks') @ApiOperation({ summary: 'Payment webhook events (failed, invalid signature, …)' })
  webhooks(@Query() q: WebhooksQuery) {
    return this.admin.webhooks(q);
  }

  @Get('audit') @ApiOperation({ summary: 'Audit log across the platform' })
  auditLogs(@Query() q: AuditQuery) {
    return this.admin.auditLogs(q);
  }

  @Get('health') @ApiOperation({ summary: 'Database, Redis, stuck outbox events, queued messages' })
  health() {
    return this.admin.health();
  }

  @Get('settings') @ApiOperation({ summary: 'Platform settings editable here (commission, billing, stock holds, reconciliation)' })
  settings() {
    return this.admin.settings();
  }

  @RequirePlatformRole('PLATFORM_ADMIN') @Put('settings/:key')
  @ApiOperation({ summary: 'Change one platform setting (validated, audited)' })
  updateSetting(@CurrentUser() u: AuthUser, @Param('key') key: string, @Body() dto: SettingDto) {
    return this.admin.updateSetting(u.id, key.slice(0, 60), dto.value);
  }
}
