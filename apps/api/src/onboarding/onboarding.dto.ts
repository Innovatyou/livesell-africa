import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail, IsIn, IsInt, IsOptional, IsString, IsUrl, Length, Matches, MaxLength, Min, ValidateNested, IsBoolean } from 'class-validator';
import { E164, E164_MSG, lower, trim } from '../auth/dto';

const HANDLE = /^@?[A-Za-z0-9._]{1,60}$/;
const HANDLE_MSG = 'Enter the handle only, e.g. @fashionbyada';
const emptyToUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? undefined : typeof value === 'string' ? value.trim() : value);

/** Social links are stored as handles (rendered as links by the storefront), plus one https website. */
export class SocialLinksDto {
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @Matches(HANDLE, { message: HANDLE_MSG }) instagram?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @Matches(HANDLE, { message: HANDLE_MSG }) tiktok?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @Matches(HANDLE, { message: HANDLE_MSG }) facebook?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @Matches(HANDLE, { message: HANDLE_MSG }) x?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @Matches(HANDLE, { message: HANDLE_MSG }) youtube?: string;
  @ApiPropertyOptional({ example: 'https://fashionbyada.com' })
  @IsOptional() @Transform(emptyToUndefined) @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'Website must start with https://' }) @MaxLength(200)
  website?: string;
}

export class UpdateStoreProfileDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 120) businessName?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 80) businessCategory?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 80) state?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 80) city?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(5, 300) businessAddress?: string;
  @ApiPropertyOptional({ description: 'Shown on the storefront' }) @IsOptional() @Transform(trim) @IsString() @Length(0, 1000) description?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(lower) @IsEmail() @MaxLength(254) contactEmail?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @Matches(E164, { message: E164_MSG }) contactPhone?: string;
  @ApiPropertyOptional({ example: '+2348012345678' }) @IsOptional() @Transform(trim) @Matches(E164, { message: E164_MSG }) whatsappNumber?: string;
  @ApiPropertyOptional({ type: SocialLinksDto }) @IsOptional() @ValidateNested() @Type(() => SocialLinksDto) socialLinks?: SocialLinksDto;
  @ApiPropertyOptional({ description: 'Sell beyond stock (pre-orders): orders hold what exists, the rest waits for restock and cannot be dispatched until filled' })
  @IsOptional() @IsBoolean() allowPreorders?: boolean;
}

export class UploadRequestDto {
  @ApiProperty({ example: 'image/png' }) @IsString() @MaxLength(100) contentType!: string;
  @ApiProperty({ example: 48213, description: 'Exact file size in bytes (signed into the upload URL)' }) @IsInt() @Min(1) contentLength!: number;
}

export class ConfirmUploadDto {
  @ApiProperty() @IsString() @MaxLength(300) key!: string;
}

export const REGISTRATION_TYPES = ['CAC_RC', 'CAC_BN', 'OTHER'] as const;

export class SubmitVerificationDto {
  @ApiProperty({ example: 'Fashion By Ada Enterprises' }) @Transform(trim) @IsString() @Length(2, 160) registeredName!: string;
  @ApiProperty({ enum: REGISTRATION_TYPES, description: 'CAC_RC: limited company (RC). CAC_BN: business name (BN)' })
  @IsIn(REGISTRATION_TYPES) registrationType!: (typeof REGISTRATION_TYPES)[number];
  @ApiProperty({ example: 'RC1234567' }) @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9-]{4,20}$/, { message: 'Registration number: 4–20 letters, digits or hyphens' }) registrationNumber!: string;
  @ApiProperty({ description: 'Key returned by the upload-url endpoint after uploading the certificate' }) @IsString() @MaxLength(300) documentKey!: string;
}

export class RejectVerificationDto {
  @ApiProperty({ example: 'The certificate is not legible. Please upload a clearer scan.' }) @Transform(trim) @IsString() @Length(5, 500) reason!: string;
}
