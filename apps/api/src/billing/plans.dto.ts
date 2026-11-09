import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf, ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const KOBO = /^\d{1,13}$/;
const KOBO_MSG = 'Price must be a whole number of kobo, as a string (e.g. "500000" for ₦5,000), or null for custom pricing';

/** Each limit is a non-negative integer, or null for unlimited. Every key must be present (no silent "unlimited"). */
export class PlanLimitsDto {
  @ApiProperty({ nullable: true, example: 50 }) @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) products!: number | null;
  @ApiProperty({ nullable: true, example: 200 }) @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) ordersPerMonth!: number | null;
  @ApiProperty({ nullable: true, example: 1 }) @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) staff!: number | null;
  @ApiProperty({ nullable: true, example: 1 }) @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) paymentGateways!: number | null;
}

export class UpdatePlanDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 60) name?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trim) @IsString() @Length(0, 500) description?: string | null;
  @ApiPropertyOptional({ nullable: true, example: '500000', description: 'Kobo as string; null = custom pricing' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(KOBO, { message: KOBO_MSG }) monthlyPriceMinor?: string | null;
  @ApiPropertyOptional({ nullable: true, example: '5000000' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(KOBO, { message: KOBO_MSG }) annualPriceMinor?: string | null;
  @ApiPropertyOptional({ example: 14 }) @IsOptional() @IsInt() @Min(0) @Max(365) trialDays?: number;
  @ApiPropertyOptional({ type: PlanLimitsDto }) @IsOptional() @ValidateNested() @Type(() => PlanLimitsDto) limits?: PlanLimitsDto;
  @ApiPropertyOptional({ example: { whatsappNotifications: true, analytics: 'standard' } }) @IsOptional() @IsObject() features?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublic?: boolean;
  @ApiPropertyOptional({ enum: ['SUBSCRIPTION', 'COMMISSION'], description: 'COMMISSION: no fixed fee (prices must be "0"), commissionBps per verified sale' })
  @IsOptional() @IsIn(['SUBSCRIPTION', 'COMMISSION']) pricingModel?: 'SUBSCRIPTION' | 'COMMISSION';
  @ApiPropertyOptional({ nullable: true, example: 300, description: 'Basis points (300 = 3%). Required for COMMISSION, null for SUBSCRIPTION' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(10000) commissionBps?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class CreatePlanDto {
  @ApiProperty({ example: 'GROWTH' }) @Matches(/^[A-Z][A-Z0-9_]{1,29}$/, { message: 'Code: 2–30 upper-case letters, digits or _' })
  code!: string;
  @ApiProperty() @Transform(trim) @IsString() @Length(2, 60) name!: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trim) @IsString() @Length(0, 500) description?: string | null;
  @ApiPropertyOptional({ example: 'NGN' }) @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
  @ApiProperty({ nullable: true, example: '500000' }) @ValidateIf((_, v) => v !== null) @Matches(KOBO, { message: KOBO_MSG })
  monthlyPriceMinor!: string | null;
  @ApiProperty({ nullable: true, example: '5000000' }) @ValidateIf((_, v) => v !== null) @Matches(KOBO, { message: KOBO_MSG })
  annualPriceMinor!: string | null;
  @ApiPropertyOptional({ example: 14 }) @IsOptional() @IsInt() @Min(0) @Max(365) trialDays?: number;
  @ApiProperty({ type: PlanLimitsDto }) @ValidateNested() @Type(() => PlanLimitsDto) limits!: PlanLimitsDto;
  @ApiProperty({ example: { whatsappNotifications: true } }) @IsObject() features!: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublic?: boolean;
  @ApiPropertyOptional({ enum: ['SUBSCRIPTION', 'COMMISSION'], description: 'COMMISSION: no fixed fee (prices must be "0"), commissionBps per verified sale' })
  @IsOptional() @IsIn(['SUBSCRIPTION', 'COMMISSION']) pricingModel?: 'SUBSCRIPTION' | 'COMMISSION';
  @ApiPropertyOptional({ nullable: true, example: 300, description: 'Basis points (300 = 3%). Required for COMMISSION, null for SUBSCRIPTION' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(10000) commissionBps?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class ChangePlanDto {
  @ApiProperty({ example: 'PROFESSIONAL' }) @Matches(/^[A-Z][A-Z0-9_]{1,29}$/) planCode!: string;
  @ApiProperty({ enum: ['MONTHLY', 'ANNUAL'] }) @IsIn(['MONTHLY', 'ANNUAL']) interval!: 'MONTHLY' | 'ANNUAL';
}
