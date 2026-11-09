import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { CurrentTenant, CurrentUser, RequirePermissions } from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import type { DeliveryStatus } from '../generated/prisma/client';
import { DeliveryService } from './delivery.service';

const KOBO = /^\d{1,13}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const MOVES = ['ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED'] as const;
const BOARD = ['PENDING', ...MOVES] as const;

export class DeliverySettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() pickupEnabled?: boolean;
  @ApiPropertyOptional({ example: 'Shop 12, Computer Village, Ikeja' }) @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(trim) @IsString() @MaxLength(300) pickupAddress?: string | null;
  @ApiPropertyOptional({ example: 'Mon–Sat, 10am–6pm. Call on arrival.' }) @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(trim) @IsString() @MaxLength(300) pickupInstructions?: string | null;
  @ApiPropertyOptional({ description: 'Accept delivery orders to places no zone covers (fee agreed later)' }) @IsOptional() @IsBoolean() deliverOutsideZones?: boolean;
}

export class ZoneDto {
  @ApiProperty({ example: 'Lagos Mainland' }) @Transform(trim) @IsString() @Length(2, 80) name!: string;
  @ApiPropertyOptional({ example: ['Lagos'] }) @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(80, { each: true }) states?: string[];
  @ApiPropertyOptional({ example: ['Ikeja', 'Yaba'] }) @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(80, { each: true }) cities?: string[];
  @ApiProperty({ example: '250000', description: 'Fee in kobo' }) @Matches(KOBO, { message: 'feeMinor must be a whole number of kobo' }) feeMinor!: string;
  @ApiPropertyOptional({ example: 2, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Number) @IsInt() @Min(0) @Max(60) etaDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateZoneDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 80) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(80, { each: true }) states?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(80, { each: true }) cities?: string[];
  @ApiPropertyOptional() @IsOptional() @Matches(KOBO, { message: 'feeMinor must be a whole number of kobo' }) feeMinor?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Number) @IsInt() @Min(0) @Max(60) etaDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

const E164 = /^\+[1-9]\d{7,14}$/;

export class CourierDto {
  @ApiProperty({ example: 'Musa (rider)' }) @Transform(trim) @IsString() @Length(2, 80) name!: string;
  @ApiPropertyOptional({ enum: ['RIDER', 'COMPANY'], default: 'RIDER' }) @IsOptional() @IsIn(['RIDER', 'COMPANY']) kind?: 'RIDER' | 'COMPANY';
  @ApiPropertyOptional({ example: '+2348031234567', nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(trim) @Matches(E164, { message: 'phone must be in international format, e.g. +2348031234567' }) phone?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(trim) @IsString() @MaxLength(300) notes?: string | null;
  @ApiPropertyOptional({ description: 'Show the phone number to customers while their order is on its way' }) @IsOptional() @IsBoolean() showPhoneToCustomer?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateCourierDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 80) name?: string;
  @ApiPropertyOptional({ enum: ['RIDER', 'COMPANY'] }) @IsOptional() @IsIn(['RIDER', 'COMPANY']) kind?: 'RIDER' | 'COMPANY';
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(trim) @Matches(E164, { message: 'phone must be in international format, e.g. +2348031234567' }) phone?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(trim) @IsString() @MaxLength(300) notes?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() showPhoneToCustomer?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class DeliveryDetailsDto {
  @ApiPropertyOptional({ enum: ['PICKUP', 'SELLER_DELIVERY', 'THIRD_PARTY'] }) @IsOptional() @IsIn(['PICKUP', 'SELLER_DELIVERY', 'THIRD_PARTY']) method?: 'PICKUP' | 'SELLER_DELIVERY' | 'THIRD_PARTY';
  @ApiPropertyOptional({ nullable: true, description: 'One of the store’s couriers (fills in the carrier name)' }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() courierId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Matches(/^[0-9a-f-]{36}$/i) zoneId?: string | null;
  @ApiPropertyOptional({ example: 'GIG Logistics', nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(80) carrierName?: string | null;
  @ApiPropertyOptional({ example: 'GIG-123456', nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(80) trackingReference?: string | null;
  @ApiPropertyOptional({ example: 'Rider: Musa, 0803 000 0000', nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) dispatchNote?: string | null;
}

export class DeliveryMoveDto {
  @ApiProperty({ enum: MOVES }) @IsIn(MOVES) status!: (typeof MOVES)[number];
  @ApiPropertyOptional({ example: 'Customer not reachable; will retry tomorrow' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
}

export class BoardQueryDto {
  @ApiPropertyOptional({ enum: BOARD }) @IsOptional() @IsIn(BOARD) status?: DeliveryStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() courierId?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

@ApiTags('delivery')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ version: '1' })
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @RequirePermissions('orders:read') @Get('delivery/settings')
  @ApiOperation({ summary: 'Pickup settings, delivery zones and the logistics adapters available' })
  settings(@CurrentTenant() t: TenantContext) {
    return this.delivery.settings(t.tenantId);
  }

  @RequirePermissions('delivery:manage') @Put('delivery/settings')
  @ApiOperation({ summary: 'Pickup and out-of-zone delivery settings' })
  saveSettings(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: DeliverySettingsDto) {
    return this.delivery.saveSettings(t.tenantId, u.id, dto);
  }

  @RequirePermissions('delivery:manage') @Post('delivery/zones')
  @ApiOperation({ summary: 'Add a delivery zone (states and/or cities, fee in kobo, days)' })
  createZone(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: ZoneDto) {
    return this.delivery.createZone(t.tenantId, u.id, dto);
  }

  @RequirePermissions('delivery:manage') @Patch('delivery/zones/:id')
  @ApiOperation({ summary: 'Change a delivery zone' })
  updateZone(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateZoneDto) {
    return this.delivery.updateZone(t.tenantId, u.id, id, dto);
  }

  @RequirePermissions('delivery:manage') @Delete('delivery/zones/:id')
  @ApiOperation({ summary: 'Remove a zone (switched off instead when past orders used it)' })
  deleteZone(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.deleteZone(t.tenantId, u.id, id);
  }

  @RequirePermissions('delivery:manage') @Post('delivery/couriers')
  @ApiOperation({ summary: 'Add one of your own riders or a courier company you book yourself' })
  createCourier(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: CourierDto) {
    return this.delivery.createCourier(t.tenantId, u.id, dto);
  }

  @RequirePermissions('delivery:manage') @Patch('delivery/couriers/:id')
  @ApiOperation({ summary: 'Change a courier' })
  updateCourier(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCourierDto) {
    return this.delivery.updateCourier(t.tenantId, u.id, id, dto);
  }

  @RequirePermissions('delivery:manage') @Delete('delivery/couriers/:id')
  @ApiOperation({ summary: 'Remove a courier (switched off instead when they carried orders)' })
  deleteCourier(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.deleteCourier(t.tenantId, u.id, id);
  }

  @RequirePermissions('orders:read') @Get('delivery/quote')
  @ApiOperation({ summary: 'Delivery fee for an address (for staff entering an order)' })
  quote(@CurrentTenant() t: TenantContext, @Query('state') state?: string, @Query('city') city?: string) {
    return this.delivery.options(t.tenantId, state && city ? { state: state.slice(0, 80), city: city.slice(0, 80) } : null);
  }

  @RequirePermissions('orders:read') @Get('deliveries')
  @ApiOperation({ summary: 'Dispatch board: paid orders and their delivery status' })
  board(@CurrentTenant() t: TenantContext, @Query() q: BoardQueryDto) {
    return this.delivery.board(t.tenantId, q);
  }

  @RequirePermissions('orders:read') @Get('orders/:id/delivery')
  @ApiOperation({ summary: 'The order’s delivery: method, zone, carrier, tracking, status and next steps' })
  get(@CurrentTenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.forOrder(t.tenantId, id);
  }

  @RequirePermissions('orders:update_status') @Put('orders/:id/delivery')
  @ApiOperation({ summary: 'Set the delivery method, zone, carrier, tracking reference and dispatch note' })
  save(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliveryDetailsDto) {
    return this.delivery.saveDetails(t, u.id, id, dto);
  }

  @RequirePermissions('orders:update_status') @Post('orders/:id/delivery/status') @HttpCode(200)
  @ApiOperation({ summary: 'Move the delivery (IN_TRANSIT dispatches the order, DELIVERED delivers it; FAILED/RETURNED need a note)' })
  move(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliveryMoveDto) {
    return this.delivery.move(t, u.id, id, dto.status, dto.note);
  }
}
