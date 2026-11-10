import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Equals, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { E164, E164_MSG, PASSWORD, PASSWORD_MSG, lower, trim } from '../auth/dto';

export const INVITABLE_ROLES = ['STORE_MANAGER', 'SALES_ASSISTANT', 'LIVE_MODERATOR', 'DISPATCHER', 'ACCOUNTANT', 'CUSTOMER_CARE'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export class CreateInvitationDto {
  @ApiProperty({ example: 'tunde@example.com' }) @Transform(lower) @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty({ enum: INVITABLE_ROLES }) @IsIn(INVITABLE_ROLES) roleKey!: InvitableRole;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ enum: INVITABLE_ROLES }) @IsOptional() @IsIn(INVITABLE_ROLES) roleKey?: InvitableRole;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED'] }) @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: 'ACTIVE' | 'DISABLED';
}

export class InvitationTokenDto {
  @ApiProperty() @IsString() @Length(20, 200) token!: string;
}

export class AcceptInvitationNewUserDto {
  @ApiProperty() @IsString() @Length(20, 200) token!: string;
  @ApiProperty({ example: 'Tunde Bello' }) @Transform(trim) @IsString() @Length(2, 120) fullName!: string;
  @ApiProperty() @Matches(PASSWORD, { message: PASSWORD_MSG }) password!: string;
  @ApiPropertyOptional({ example: '+2348012345678' }) @IsOptional() @Transform(trim) @Matches(E164, { message: E164_MSG }) phone?: string;
  @ApiProperty({ example: true, description: 'Accepts the terms of service and privacy policy' })
  @Equals(true, { message: 'You must accept the terms of service and privacy policy' }) acceptTerms!: boolean;
}
