import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Equals, IsEmail, IsEnum, IsISO31661Alpha2, IsOptional, IsString, Length, Matches, MaxLength, MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

// ≥10 chars, at least one letter and one digit. Length matters more than symbols (NIST 800-63B).
const PASSWORD = /^(?=.*[A-Za-z])(?=.*\d).{10,128}$/;
const PASSWORD_MSG = 'Password must be 10–128 characters and include a letter and a number';

export class RegisterDto {
  @ApiProperty({ example: 'Fashion by Ada' }) @Transform(trim) @IsString() @Length(2, 120)
  businessName!: string;

  @ApiProperty({ example: 'Ada Okafor' }) @Transform(trim) @IsString() @Length(2, 120)
  ownerFullName!: string;

  @ApiProperty({ example: 'ada@example.com' }) @Transform(lower) @IsEmail() @MaxLength(254)
  email!: string;

  @ApiProperty({ example: '+2348012345678', description: 'E.164 format' })
  @Transform(trim) @Matches(/^\+[1-9]\d{7,14}$/, { message: 'Phone must be in E.164 format, e.g. +2348012345678' })
  phone!: string;

  @ApiProperty({ example: 'NG' }) @Transform(({ value }) => String(value).toUpperCase()) @IsISO31661Alpha2()
  country!: string;

  @ApiProperty({ example: 'Lagos' }) @Transform(trim) @IsString() @Length(2, 80)
  state!: string;

  @ApiProperty({ example: 'Ikeja' }) @Transform(trim) @IsString() @Length(2, 80)
  city!: string;

  @ApiProperty() @Transform(trim) @IsString() @Length(5, 300)
  businessAddress!: string;

  @ApiProperty({ example: 'Fashion & Apparel' }) @Transform(trim) @IsString() @Length(2, 80)
  businessCategory!: string;

  @ApiProperty({ example: 'fashionbyada', description: 'Becomes livesell.africa/store/<username>' })
  @Transform(lower)
  @Matches(/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/, { message: 'Store username: 3–40 lowercase letters, numbers or hyphens' })
  storeUsername!: string;

  @ApiProperty({ enum: ['INDIVIDUAL', 'REGISTERED_BUSINESS'] }) @IsEnum(['INDIVIDUAL', 'REGISTERED_BUSINESS'])
  businessType!: 'INDIVIDUAL' | 'REGISTERED_BUSINESS';

  @ApiProperty() @Matches(PASSWORD, { message: PASSWORD_MSG })
  password!: string;

  @ApiProperty({ example: true }) @Equals(true, { message: 'You must accept the terms and conditions' })
  acceptTerms!: boolean;

  @ApiProperty({ example: true }) @Equals(true, { message: 'You must accept the privacy policy' })
  acceptPrivacy!: boolean;
}

export class LoginDto {
  @ApiProperty() @Transform(lower) @IsEmail() email!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

export class RefreshDto {
  @ApiPropertyOptional({ description: 'Mobile clients only; web uses the httpOnly cookie' })
  @IsOptional() @IsString() @MaxLength(200) refreshToken?: string;
}

export class TokenDto {
  @ApiProperty() @IsString() @Length(20, 200) token!: string;
}

export class ForgotPasswordDto {
  @ApiProperty() @Transform(lower) @IsEmail() email!: string;
}

export const E164 = /^\+[1-9]\d{7,14}$/;
export const E164_MSG = 'Phone must be in E.164 format, e.g. +2348012345678';

export class SendPhoneOtpDto {
  @ApiPropertyOptional({ example: '+2348012345678', description: 'Set or change the phone number before sending' })
  @IsOptional() @Transform(trim) @Matches(E164, { message: E164_MSG })
  phone?: string;
}

export class VerifyPhoneOtpDto {
  @ApiProperty({ example: '123456' }) @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code' })
  code!: string;
}

export { PASSWORD, PASSWORD_MSG, trim, lower };

export class ResetPasswordDto {
  @ApiProperty() @IsString() @Length(20, 200) token!: string;
  @ApiProperty() @Matches(PASSWORD, { message: PASSWORD_MSG }) newPassword!: string;
}
