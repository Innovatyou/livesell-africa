import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentTenant, CurrentUser, RequirePermissions } from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { AddressDto, CreateCustomerDto, ListCustomersQuery, UpdateCustomerDto } from './customers.dto';
import { CustomersService } from './customers.service';

@ApiTags('customers')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @RequirePermissions('customers:read') @Get()
  @ApiOperation({ summary: 'Customers with spend/order stats; segments: repeat, new, vip, inactive, outstanding, opted_in' })
  list(@CurrentTenant() t: TenantContext, @Query() q: ListCustomersQuery) {
    return this.customers.list(t.tenantId, q);
  }

  @RequirePermissions('customers:export') @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8') @Header('Content-Disposition', 'attachment; filename="customers.csv"')
  @ApiProduces('text/csv') @ApiOperation({ summary: 'Export customers (personal data; requires customers:export; audited)' })
  export(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Query() q: ListCustomersQuery, @Req() req: Request) {
    return this.customers.exportCsv(t.tenantId, u.id, q, req.ip);
  }

  @RequirePermissions('customers:read') @Get('tags') @ApiOperation({ summary: 'Tags in use, with counts' })
  tags(@CurrentTenant() t: TenantContext) {
    return this.customers.tags(t.tenantId);
  }

  @RequirePermissions('customers:read') @Get(':id') @ApiOperation({ summary: 'Profile, addresses, stats and recent orders' })
  get(@CurrentTenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.get(t.tenantId, id);
  }

  @RequirePermissions('customers:write') @Post()
  create(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: CreateCustomerDto) {
    return this.customers.create(t.tenantId, u.id, dto);
  }

  @RequirePermissions('customers:write') @Patch(':id')
  update(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(t.tenantId, u.id, id, dto);
  }

  @RequirePermissions('customers:write') @Delete(':id') @HttpCode(204)
  @ApiOperation({ summary: 'Delete a customer who has never ordered' })
  async remove(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.customers.remove(t.tenantId, u.id, id);
  }

  @RequirePermissions('customers:write') @Post(':id/anonymise') @HttpCode(200)
  @ApiOperation({ summary: 'Erase personal data (NDPA right to erasure); order amounts are kept' })
  anonymise(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.anonymise(t.tenantId, u.id, id);
  }

  @RequirePermissions('customers:write') @Post(':id/addresses')
  addAddress(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddressDto) {
    return this.customers.addAddress(t.tenantId, u.id, id, dto);
  }

  @RequirePermissions('customers:write') @Patch(':id/addresses/:addressId')
  updateAddress(
    @CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string, @Param('addressId', ParseUUIDPipe) addressId: string, @Body() dto: AddressDto,
  ) {
    return this.customers.updateAddress(t.tenantId, u.id, id, addressId, dto);
  }

  @RequirePermissions('customers:write') @Delete(':id/addresses/:addressId') @HttpCode(204)
  async removeAddress(
    @CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string, @Param('addressId', ParseUUIDPipe) addressId: string,
  ) {
    await this.customers.removeAddress(t.tenantId, u.id, id, addressId);
  }
}
