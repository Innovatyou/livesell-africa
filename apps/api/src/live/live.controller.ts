import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser, RequirePermissions } from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { CreateChannelDto, CreateSessionDto, EndSessionDto, ListSessionsQuery, UpdateChannelDto, UpdateSessionDto } from './live.dto';
import { LiveService } from './live.service';

@ApiTags('live sessions')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ path: 'live-sessions', version: '1' })
export class LiveSessionsController {
  constructor(private readonly live: LiveService) {}

  @RequirePermissions('live:read') @Get() @ApiOperation({ summary: 'Live sessions (upcoming / past) with paid orders and revenue' })
  list(@CurrentTenant() t: TenantContext, @Query() q: ListSessionsQuery) {
    return this.live.list(t.tenantId, q);
  }

  @RequirePermissions('live:read') @Get(':id') @ApiOperation({ summary: 'Session with promoted products (codes, stock, live prices) and moderators' })
  get(@CurrentTenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.live.get(t.tenantId, id);
  }

  @RequirePermissions('live:read') @Get(':id/report') @ApiOperation({ summary: 'Sales report from the session’s real orders' })
  report(@CurrentTenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.live.report(t.tenantId, id);
  }

  @RequirePermissions('live:manage') @Post() @ApiOperation({ summary: 'Schedule a live session' })
  create(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: CreateSessionDto) {
    return this.live.create(t.tenantId, u.id, dto);
  }

  @RequirePermissions('live:manage') @Patch(':id') @ApiOperation({ summary: 'Edit a scheduled or live session (products/moderators replace the lists)' })
  update(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSessionDto) {
    return this.live.update(t.tenantId, u.id, id, dto);
  }

  @RequirePermissions('live:manage') @Post(':id/start') @HttpCode(200)
  start(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.live.start(t.tenantId, u.id, id);
  }

  @RequirePermissions('live:manage') @Post(':id/end') @HttpCode(200)
  @ApiOperation({ summary: 'End the session; optionally record the peak viewers the platform showed (seller-reported)' })
  end(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EndSessionDto) {
    return this.live.end(t.tenantId, u.id, id, dto.peakViewers);
  }

  @RequirePermissions('live:manage') @Post(':id/cancel') @HttpCode(200)
  cancel(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.live.cancel(t.tenantId, u.id, id);
  }
}

@ApiTags('live sessions')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ path: 'sales-channels', version: '1' })
export class SalesChannelsController {
  constructor(private readonly live: LiveService) {}

  @RequirePermissions('orders:read') @Get() @ApiOperation({ summary: 'Sales channels (TikTok, Instagram, WhatsApp, storefront, manual …)' })
  list(@CurrentTenant() t: TenantContext) {
    return this.live.channels(t.tenantId);
  }

  @RequirePermissions('live:manage') @Post()
  create(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: CreateChannelDto) {
    return this.live.createChannel(t.tenantId, u.id, dto);
  }

  @RequirePermissions('live:manage') @Patch(':id')
  update(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateChannelDto) {
    return this.live.updateChannel(t.tenantId, u.id, id, dto);
  }
}
