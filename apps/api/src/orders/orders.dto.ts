import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length,
  Matches, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { E164, E164_MSG, lower, trim } from '../auth/dto';

const KOBO = /^\d{1,13}$/;
const KOBO_MSG = 'Amounts are whole kobo as a string, e.g. "150000" for ₦1,500';
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, '') : value);

export const ORDER_STATUSES = ['DRAFT', 'PENDING_PAYMENT', 'PAYMENT_VERIFICATION', 'PAID', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;
export type OrderStatusValue = (typeof ORDER_STATUSES)[number];
/** What a person may request; PAID/verification/refunds come only from the payments module. */
export const USER_TARGET_STATUSES = ['PENDING_PAYMENT', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED', 'CANCELLED'] as const;

export class OrderItemInputDto {
  @ApiPropertyOptional({ description: 'Variant id (from the product list)' }) @IsOptional() @IsUUID() variantId?: string;
  @ApiPropertyOptional({ example: 'BAG001', description: 'Or the product code customers send' }) @IsOptional() @Transform(upper) @Matches(/^[A-Z0-9-]{2,20}$/) productCode?: string;
  @ApiPropertyOptional({ example: 'BAG001-BLAC', description: 'Which variant, when the code has several' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(64) variantSku?: string;
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) @Max(999) quantity!: number;
  @ApiPropertyOptional({ example: '0', description: 'Line discount in kobo' }) @IsOptional() @Matches(KOBO, { message: KOBO_MSG }) discountMinor?: string;
}

export class OrderCustomerDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional({ example: 'Chiamaka Eze' }) @IsOptional() @Transform(trim) @IsString() @Length(2, 120) fullName?: string;
  @ApiPropertyOptional({ example: '+2348031234567' }) @IsOptional() @Transform(trim) @Matches(E164, { message: E164_MSG }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(lower) @IsEmail() @MaxLength(254) email?: string;
}

export class ShippingAddressDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 120) fullName?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @Matches(E164, { message: E164_MSG }) phone?: string;
  @ApiProperty({ example: '12 Allen Avenue' }) @Transform(trim) @IsString() @Length(3, 200) line1!: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(200) line2?: string;
  @ApiProperty({ example: 'Ikeja' }) @Transform(trim) @IsString() @Length(2, 80) city!: string;
  @ApiProperty({ example: 'Lagos' }) @Transform(trim) @IsString() @Length(2, 80) state!: string;
  @ApiPropertyOptional({ example: 'Opposite Shoprite' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(200) landmark?: string;
}

class OrderFields {
  @ApiPropertyOptional({ type: OrderCustomerDto }) @IsOptional() @ValidateNested() @Type(() => OrderCustomerDto) customer?: OrderCustomerDto;
  @ApiPropertyOptional({ example: '0' }) @IsOptional() @Matches(KOBO, { message: KOBO_MSG }) discountMinor?: string;
  @ApiPropertyOptional({ example: '150000' }) @IsOptional() @Matches(KOBO, { message: KOBO_MSG }) deliveryFeeMinor?: string;
  @ApiPropertyOptional({ type: ShippingAddressDto }) @IsOptional() @ValidateNested() @Type(() => ShippingAddressDto) shippingAddress?: ShippingAddressDto;
  @ApiPropertyOptional({ description: "Use one of the customer's saved addresses" }) @IsOptional() @IsUUID() addressId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) notes?: string;
}

export class CreateOrderDto extends OrderFields {
  @ApiProperty({ type: [OrderItemInputDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => OrderItemInputDto) items!: OrderItemInputDto[];
  @ApiPropertyOptional({ description: 'Sales channel; defaults to the live session’s channel or “Manual / phone orders”' }) @IsOptional() @IsUUID() channelId?: string;
  @ApiPropertyOptional({ description: 'Live session the order came from (must be live or ended)' }) @IsOptional() @IsUUID() liveSessionId?: string;
  @ApiPropertyOptional({ default: true, description: 'true: confirm now (reserves stock, awaits payment). false: save as draft' }) @IsOptional() @IsBoolean() confirm?: boolean;
  @ApiPropertyOptional({ example: 'm-3f1c2a9e-7b11', description: 'Client’s own id for this order (mobile offline queue). Sending it again returns the same order instead of a duplicate.' })
  @IsOptional() @Matches(/^[A-Za-z0-9_-]{8,64}$/) clientRef?: string;
}

export class UpdateOrderDto extends OrderFields {
  @ApiPropertyOptional({ type: [OrderItemInputDto], description: 'Replaces all items (draft and awaiting-payment orders only)' })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => OrderItemInputDto) items?: OrderItemInputDto[];
}

export class TransitionDto {
  @ApiProperty({ enum: USER_TARGET_STATUSES }) @IsIn(USER_TARGET_STATUSES) status!: (typeof USER_TARGET_STATUSES)[number];
  @ApiPropertyOptional({ example: 'Sent with GIG Logistics, waybill 123456' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}

export class ExtendHoldDto {
  @ApiProperty({ example: 24, description: 'Keep the stock reserved this many more hours (max 7 days from now)' }) @IsInt() @Min(1) @Max(168) hours!: number;
}

export class ListOrdersQuery {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(ORDER_STATUSES) status?: OrderStatusValue;
  @IsOptional() @IsIn(['open', 'awaiting_payment', 'to_fulfil', 'completed', 'cancelled']) view?: 'open' | 'awaiting_payment' | 'to_fulfil' | 'completed' | 'cancelled';
  @IsOptional() @IsUUID() channelId?: string;
  @IsOptional() @IsUUID() liveSessionId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(['recent', 'oldest', 'total_desc']) sort?: 'recent' | 'oldest' | 'total_desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

// ── Public storefront checkout ──

export class CheckoutItemDto {
  @ApiProperty() @IsUUID() variantId!: string;
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) @Max(20) quantity!: number;
}

export class CheckoutCustomerDto {
  @ApiProperty({ example: 'Chiamaka Eze' }) @Transform(trim) @IsString() @Length(2, 120) fullName!: string;
  @ApiProperty({ example: '+2348031234567' }) @Transform(trim) @Matches(E164, { message: E164_MSG }) phone!: string;
  @ApiPropertyOptional() @IsOptional() @Transform(lower) @IsEmail() @MaxLength(254) email?: string;
}

export class CheckoutDto {
  @ApiProperty({ type: CheckoutCustomerDto }) @ValidateNested() @Type(() => CheckoutCustomerDto) customer!: CheckoutCustomerDto;
  @ApiProperty({ type: [CheckoutItemDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => CheckoutItemDto) items!: CheckoutItemDto[];
  @ApiPropertyOptional({ enum: ['DELIVERY', 'PICKUP'], default: 'DELIVERY', description: 'PICKUP only when the store offers it; the fee is always computed by the server' })
  @IsOptional() @IsIn(['DELIVERY', 'PICKUP']) deliveryMethod?: 'DELIVERY' | 'PICKUP';
  @ApiPropertyOptional({ type: ShippingAddressDto, description: 'Required for delivery' })
  @ValidateIf((o: { deliveryMethod?: string }) => o.deliveryMethod !== 'PICKUP') @ValidateNested() @Type(() => ShippingAddressDto) shippingAddress?: ShippingAddressDto;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
  @ApiPropertyOptional({ description: 'Leave empty' }) @IsOptional() @IsString() @MaxLength(200) website?: string;
  @ApiPropertyOptional({ description: 'Send order updates on WhatsApp (the customer ticked the box)' }) @IsOptional() @IsBoolean() whatsappOptIn?: boolean;
}
