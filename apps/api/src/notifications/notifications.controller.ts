import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { CurrentTenant, CurrentUser, RequirePermissions, RequirePlatformRole } from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { MessagingProvider, VerificationProvider } from '../messaging/messaging-provider';
import { NotificationService } from './notifications.service';

const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP'] as const;
const STATUSES = ['QUEUED', 'SENT', 'DELIVERED', 'FAILED'] as const;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export class NotificationsQuery {
  @IsOptional() @IsIn(STATUSES) status?: string;
  @IsOptional() @IsIn(CHANNELS) channel?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class UsageQuery {
  @IsOptional() @Matches(PERIOD, { message: 'period is YYYY-MM' }) period?: string;
}

export class TestMessageDto {
  @ApiProperty({ enum: CHANNELS }) @IsIn(CHANNELS) channel!: 'EMAIL' | 'SMS' | 'WHATSAPP';
  @ApiProperty({ example: '+2348031234567', description: 'Email address or phone number' }) @IsString() @MaxLength(254) to!: string;
}

export class MessagingSettingsDto {
  @ApiPropertyOptional({ example: { SMS: 400, WHATSAPP: 600, EMAIL: 0 }, description: 'Price per message in kobo, charged to the seller' })
  @IsOptional() @IsObject() prices?: Record<string, number>;
  @ApiPropertyOptional({ example: { SMS: 300, WHATSAPP: 500, EMAIL: 2000 }, description: 'Messages per seller per month (a plan’s limits.messaging overrides)' })
  @IsOptional() @IsObject() limits?: Record<string, number>;
}

const pickChannels = (o?: Record<string, number>) => {
  if (!o) return undefined;
  const bad = Object.keys(o).filter((k) => !CHANNELS.includes(k as never));
  if (bad.length) throw new BadRequestException(`Unknown channel: ${bad.join(', ')}`);
  return o as Partial<Record<(typeof CHANNELS)[number], number>>;
};

@ApiTags('messaging (seller)')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ path: 'messaging', version: '1' })
export class MessagingController {
  constructor(private readonly notifications: NotificationService) {}

  @RequirePermissions('reports:read') @Get('usage')
  @ApiOperation({ summary: 'Messages sent this month per channel, against your limits, and what they cost' })
  usage(@CurrentTenant() t: TenantContext, @Query() q: UsageQuery) {
    return this.notifications.usage(t.tenantId, q.period);
  }

  @RequirePermissions('reports:read') @Get('notifications')
  @ApiOperation({ summary: 'Messages sent on behalf of your store (destinations masked)' })
  list(@CurrentTenant() t: TenantContext, @Query() q: NotificationsQuery) {
    return this.notifications.list(t.tenantId, q);
  }
}

@ApiTags('admin: messaging')
@ApiBearerAuth()
@Controller({ path: 'admin', version: '1' })
export class AdminMessagingController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly messaging: MessagingProvider,
    private readonly verification: VerificationProvider,
  ) {}

  @RequirePlatformRole('PLATFORM_ADMIN', 'PLATFORM_SUPPORT') @Get('integrations/veltrix')
  @ApiOperation({ summary: 'Veltrix connection: account, wallet balance, which channels and Verify are configured (no secrets)' })
  async status() {
    return { ...(await this.messaging.status()), verify: { configured: this.verification.enabled } };
  }

  @RequirePlatformRole('PLATFORM_ADMIN') @Post('integrations/veltrix/test') @HttpCode(200)
  @ApiOperation({ summary: 'Send a test message through Veltrix' })
  test(@Body() dto: TestMessageDto) {
    return this.notifications.send({ tenantId: null, channel: dto.channel, type: 'TEST_MESSAGE', template: 'TEST_MESSAGE', destination: dto.to, vars: {} });
  }

  @RequirePlatformRole('PLATFORM_ADMIN', 'PLATFORM_SUPPORT') @Get('messaging/settings')
  @ApiOperation({ summary: 'Messaging prices (kobo per message) and per-seller monthly limits' })
  settings() {
    return this.notifications.settings();
  }

  @RequirePlatformRole('PLATFORM_ADMIN') @Put('messaging/settings')
  @ApiOperation({ summary: 'Change messaging prices and per-seller monthly limits' })
  updateSettings(@CurrentUser() u: AuthUser, @Body() dto: MessagingSettingsDto) {
    return this.notifications.updateSettings(u.id, { prices: pickChannels(dto.prices), limits: pickChannels(dto.limits) });
  }

  @RequirePlatformRole('PLATFORM_ADMIN', 'PLATFORM_SUPPORT') @Get('messaging/usage')
  @ApiOperation({ summary: 'Messaging cost attributed to each seller for a month' })
  usage(@Query() q: UsageQuery) {
    return this.notifications.platformUsage(q.period);
  }

  @RequirePlatformRole('PLATFORM_ADMIN', 'PLATFORM_SUPPORT') @Get('messaging/notifications')
  @ApiOperation({ summary: 'All messages (filter by status, e.g. FAILED)' })
  all(@Query() q: NotificationsQuery) {
    return this.notifications.list(null, { ...q, all: true });
  }

  @RequirePlatformRole('PLATFORM_ADMIN') @Post('messaging/notifications/:id/retry') @HttpCode(200)
  @ApiOperation({ summary: 'Send a failed message again (not for codes or sign-in links, which are never stored)' })
  retry(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.retryNow(id, u.id);
  }
}
