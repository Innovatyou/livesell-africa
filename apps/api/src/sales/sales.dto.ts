import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { E164, E164_MSG, lower, trim } from '../auth/dto';

export const ORDER_BANDS = ['Under 200', '200–1,000', '1,000–5,000', '5,000–20,000', 'Over 20,000'] as const;
export const INQUIRY_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'CLOSED'] as const;

export class CreateSalesInquiryDto {
  @ApiProperty({ example: 'Ngozi Okafor' }) @Transform(trim) @IsString() @Length(2, 120) fullName!: string;
  @ApiProperty({ example: 'ngozi@brand.ng' }) @Transform(lower) @IsEmail() @MaxLength(254) email!: string;
  @ApiPropertyOptional({ example: '+2348031234567' }) @IsOptional() @Transform(trim) @Matches(E164, { message: E164_MSG }) phone?: string;
  @ApiProperty({ example: 'Okafor Beauty Ltd' }) @Transform(trim) @IsString() @Length(2, 160) businessName!: string;
  @ApiPropertyOptional({ example: 'ENTERPRISE' }) @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{1,29}$/) planInterest?: string;
  @ApiPropertyOptional({ enum: ORDER_BANDS }) @IsOptional() @IsIn(ORDER_BANDS) monthlyOrders?: (typeof ORDER_BANDS)[number];
  @ApiProperty({ example: 'We sell on TikTok Live 4 nights a week and need multiple stores.' }) @Transform(trim) @IsString() @Length(10, 3000) message!: string;
  /** Honeypot: hidden from people, filled in by bots. Must be empty. */
  @ApiPropertyOptional({ description: 'Leave empty' }) @IsOptional() @IsString() @MaxLength(200) website?: string;
}

export class UpdateSalesInquiryDto {
  @ApiPropertyOptional({ enum: INQUIRY_STATUSES }) @IsOptional() @IsIn(INQUIRY_STATUSES) status?: (typeof INQUIRY_STATUSES)[number];
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) notes?: string;
}
