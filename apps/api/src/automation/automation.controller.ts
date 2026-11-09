import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiHeader, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, ValidateIf, Matches } from 'class-validator';
import type { Request } from 'express';
import { CurrentTenant, CurrentUser, Public, RequirePermissions, RequirePlatformRole } from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { NotificationService } from '../notifications/notifications.service';
import { OrderNotifier } from './order-notifier.service';
import { WhatsappAdminService } from './whatsapp-admin.service';
import { WhatsappCommerceService } from './whatsapp-commerce.service';

export class NotifyOrderDto {
  @IsIn(['PAYMENT_REMINDER']) event!: 'PAYMENT_REMINDER';
}

export class WhatsappSettingsDto {
  @ApiPropertyOptional({ example: '+2348031234567', nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(/^\+[1-9]\d{7,14}$/) platformNumber?: string | null;
  @ApiPropertyOptional({ example: { ORDER_PLACED: { name: 'order_placed', language: 'en' } } }) @IsOptional() @IsObject() templates?: Record<string, { name: string; language: string } | null>;
}

@ApiTags('automation (seller)')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ version: '1' })
export class AutomationController {
  constructor(private readonly notifier: OrderNotifier, private readonly notifications: NotificationService) {}

  @RequirePermissions('store:manage') @Get('notifications/preferences')
  @ApiOperation({ summary: 'Which automatic customer messages this store sends, on which channels, and reminder timing' })
  preferences(@CurrentTenant() t: TenantContext) {
    return this.notifier.preferences(t.tenantId);
  }

  @RequirePermissions('store:manage') @Put('notifications/preferences')
  @ApiOperation({ summary: 'Change automatic customer messages (unknown keys ignored, invalid values fall back to defaults)' })
  save(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() body: Record<string, unknown>) {
    return this.notifier.savePreferences(t.tenantId, u.id, body);
  }

  @RequirePermissions('orders:create') @Post('orders/:id/notify') @HttpCode(200)
  @ApiOperation({ summary: 'Send the customer a payment reminder now (at most every 6 hours)' })
  notify(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() _dto: NotifyOrderDto) {
    return this.notifier.remindNow(t.tenantId, u.id, id);
  }

  @RequirePermissions('orders:read') @Get('orders/:id/notifications')
  @ApiOperation({ summary: 'Messages sent to the customer about this order' })
  messages(@CurrentTenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.forOrder(t.tenantId, id);
  }
}

@ApiTags('whatsapp (public)')
@Controller({ version: '1' })
export class WhatsappPublicController {
  constructor(private readonly admin: WhatsappAdminService, private readonly commerce: WhatsappCommerceService) {}

  /** Veltrix forwards the platform number's inbound messages here (signed). Non-2xx makes Veltrix retry. */
  @Public() @Post('whatsapp/webhook') @HttpCode(200) @ApiExcludeEndpoint()
  async inbound(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-veltrix-signature') sig: string | undefined, @Headers('x-veltrix-delivery') delivery: string | undefined, @Body() body: { event?: string; data?: Record<string, unknown> }) {
    if (!(await this.admin.verify(req.rawBody, sig)) || !delivery || !/^[0-9a-f]{16,64}$/i.test(delivery)) throw new UnauthorizedException('Invalid signature');
    return this.commerce.handleDelivery(delivery, body);
  }

  @Public() @Get('store/:slug/whatsapp-ordering')
  @ApiOperation({ summary: 'Whether customers can order from this store on WhatsApp, and the number to message' })
  ordering(@Param('slug') slug: string) {
    return this.admin.ordering(slug.slice(0, 40));
  }
}

@ApiTags('admin: whatsapp')
@ApiBearerAuth()
@Controller({ path: 'admin/whatsapp', version: '1' })
export class AdminWhatsappController {
  constructor(private readonly admin: WhatsappAdminService) {}

  @RequirePlatformRole('PLATFORM_ADMIN', 'PLATFORM_SUPPORT') @Get()
  @ApiOperation({ summary: 'Platform WhatsApp number, forwarding status, approved templates and the event → template mapping' })
  settings() {
    return this.admin.settings();
  }

  @RequirePlatformRole('PLATFORM_ADMIN') @Put()
  @ApiOperation({ summary: 'Set the platform number and which approved template each order event uses' })
  update(@CurrentUser() u: AuthUser, @Body() dto: WhatsappSettingsDto) {
    return this.admin.update(u.id, dto);
  }

  @RequirePlatformRole('PLATFORM_ADMIN') @Post('forwarding') @HttpCode(200)
  @ApiOperation({ summary: 'Connect Veltrix forwarding of the platform number’s inbound messages to LiveSell' })
  connect(@CurrentUser() u: AuthUser) {
    return this.admin.connectForwarding(u.id);
  }
}
