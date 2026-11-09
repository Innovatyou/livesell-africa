import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsISO31661Alpha2, IsOptional, IsString, Length, Matches, Max, MaxLength, Min,
  ValidateIf, ValidateNested,
} from 'class-validator';
import { E164, E164_MSG, lower, trim } from '../auth/dto';

export class AddressDto {
  @ApiPropertyOptional({ example: 'Home' }) @IsOptional() @Transform(trim) @IsString() @Length(1, 40) label?: string;
  @ApiProperty({ example: '12 Allen Avenue' }) @Transform(trim) @IsString() @Length(3, 200) line1!: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(200) line2?: string;
  @ApiProperty({ example: 'Ikeja' }) @Transform(trim) @IsString() @Length(2, 80) city!: string;
  @ApiProperty({ example: 'Lagos' }) @Transform(trim) @IsString() @Length(2, 80) state!: string;
  @ApiPropertyOptional({ example: 'NG' }) @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value)) @IsISO31661Alpha2() country?: string;
  @ApiPropertyOptional({ example: 'Opposite Shoprite' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(200) landmark?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

class CustomerFields {
  @ApiPropertyOptional({ example: '+2348031234567', nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(trim) @Matches(E164, { message: E164_MSG }) phone?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(lower) @IsEmail() @MaxLength(254) email?: string | null;
  @ApiPropertyOptional({ description: 'Customer agreed to receive WhatsApp messages' }) @IsOptional() @IsBoolean() whatsappOptIn?: boolean;
  @ApiPropertyOptional({ example: ['vip', 'lagos'] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @Length(1, 30, { each: true }) tags?: string[];
  @ApiPropertyOptional({ description: 'Internal notes (not shown to the customer)' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) notes?: string;
}

export class CreateCustomerDto extends CustomerFields {
  @ApiProperty({ example: 'Chiamaka Eze' }) @Transform(trim) @IsString() @Length(2, 120) fullName!: string;
  @ApiPropertyOptional({ type: AddressDto }) @IsOptional() @ValidateNested() @Type(() => AddressDto) address?: AddressDto;
}

export class UpdateCustomerDto extends CustomerFields {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 120) fullName?: string;
}

export const SEGMENTS = ['all', 'repeat', 'new', 'vip', 'inactive', 'outstanding', 'opted_in'] as const;
export type Segment = (typeof SEGMENTS)[number];

export class ListCustomersQuery {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(SEGMENTS) segment?: Segment;
  @IsOptional() @Transform(lower) @IsString() @MaxLength(30) tag?: string;
  @IsOptional() @IsIn(['recent', 'spend', 'orders', 'last_order', 'name']) sort?: 'recent' | 'spend' | 'orders' | 'last_order' | 'name';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
