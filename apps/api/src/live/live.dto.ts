import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export const CHANNEL_TYPES = ['TIKTOK_LIVE', 'INSTAGRAM_LIVE', 'FACEBOOK_LIVE', 'YOUTUBE_LIVE', 'WHATSAPP', 'STOREFRONT', 'MANUAL', 'OTHER'] as const;
export const LIVE_CHANNEL_TYPES = ['TIKTOK_LIVE', 'INSTAGRAM_LIVE', 'FACEBOOK_LIVE', 'YOUTUBE_LIVE', 'WHATSAPP', 'OTHER'] as const;

export class SessionProductDto {
  @ApiProperty() @IsUUID() productId!: string;
  @ApiPropertyOptional({ nullable: true, example: '2000000', description: 'Live-only price in kobo (applies to every variant)' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(/^\d{1,13}$/) sessionPriceMinor?: string | null;
}

class SessionFields {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional({ example: 'Comment the code (e.g. BAG001) and send it to our WhatsApp to order.' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500) orderInstructions?: string;
  @ApiPropertyOptional({ type: [SessionProductDto] }) @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SessionProductDto) products?: SessionProductDto[];
  @ApiPropertyOptional({ description: 'Team member ids (from /workspace/members)' }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) moderatorIds?: string[];
}

export class CreateSessionDto extends SessionFields {
  @ApiProperty({ example: 'Friday Night Bag Drop' }) @Transform(trim) @IsString() @Length(2, 140) title!: string;
  @ApiProperty({ description: 'Sales channel id (create one first with POST /sales-channels)' }) @IsUUID() channelId!: string;
  @ApiProperty({ example: '2026-11-07T19:00:00+01:00' }) @IsDateString() scheduledAt!: string;
}

export class UpdateSessionDto extends SessionFields {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 140) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() channelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() scheduledAt?: string;
}

export class EndSessionDto {
  @ApiPropertyOptional({ description: 'Peak viewers as shown by the platform, entered by the seller. Never estimated.' })
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) peakViewers?: number;
}

export class ListSessionsQuery {
  @IsOptional() @IsIn(['SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED']) status?: 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';
  @IsOptional() @IsIn(['upcoming', 'past']) when?: 'upcoming' | 'past';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class CreateChannelDto {
  @ApiProperty({ enum: CHANNEL_TYPES }) @IsIn(CHANNEL_TYPES) type!: (typeof CHANNEL_TYPES)[number];
  @ApiProperty({ example: 'TikTok — @adafashion' }) @Transform(trim) @IsString() @Length(2, 80) name!: string;
  @ApiPropertyOptional({ example: '@adafashion' }) @IsOptional() @Transform(trim) @Matches(/^@?[A-Za-z0-9._-]{1,60}$/, { message: 'Handle only, e.g. @adafashion' }) handle?: string;
}

export class UpdateChannelDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 80) name?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(trim) @Matches(/^@?[A-Za-z0-9._-]{1,60}$/) handle?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
