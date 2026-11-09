import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentTenant, CurrentUser, RequirePermissions } from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { CreateOrderDto, ExtendHoldDto, ListOrdersQuery, TransitionDto, UpdateOrderDto } from './orders.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @RequirePermissions('orders:read') @Get()
  @ApiOperation({ summary: 'Orders with search (reference, customer, phone, product code), views, filters and pagination' })
  list(@CurrentTenant() t: TenantContext, @Query() q: ListOrdersQuery) {
    return this.orders.list(t.tenantId, q);
  }

  @RequirePermissions('orders:read', 'customers:export') @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8') @Header('Content-Disposition', 'attachment; filename="orders.csv"')
  @ApiProduces('text/csv') @ApiOperation({ summary: 'Export orders (includes customer contact details; audited)' })
  export(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Query() q: ListOrdersQuery, @Req() req: Request) {
    return this.orders.exportCsv(t.tenantId, u.id, q, req.ip);
  }

  @RequirePermissions('orders:read') @Get(':id') @ApiOperation({ summary: 'Order with items, customer, payments and full activity history' })
  get(@CurrentTenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(t.tenantId, id);
  }

  @RequirePermissions('orders:create') @Post()
  @ApiOperation({ summary: 'Create an order (manual or during a live). Confirmed orders reserve stock until paid or the hold expires' })
  async create(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: CreateOrderDto) {
    const o = await this.orders.create(t.tenantId, dto, { actorId: u.id, source: 'staff' });
    return this.orders.get(t.tenantId, o.id);
  }

  @RequirePermissions('orders:create') @Patch(':id')
  @ApiOperation({ summary: 'Edit a draft or awaiting-payment order (items are re-reserved)' })
  update(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrderDto) {
    return this.orders.update(t, u.id, id, dto);
  }

  @RequirePermissions('orders:read') @Post(':id/status') @HttpCode(200)
  @ApiOperation({ summary: 'Confirm, cancel or move through fulfilment. Paid status is set only by verified payments' })
  status(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionDto) {
    return this.orders.transition(t, u.id, id, dto.status, dto.note);
  }

  @RequirePermissions('orders:create') @Post(':id/extend-hold') @HttpCode(200)
  @ApiOperation({ summary: 'Keep stock reserved longer for an order awaiting payment' })
  extendHold(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtendHoldDto) {
    return this.orders.extendHold(t.tenantId, u.id, id, dto.hours);
  }
}
