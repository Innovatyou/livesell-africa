import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Matches,
  Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const KOBO = /^\d{1,13}$/;
const KOBO_MSG = 'Amounts are whole kobo as a string, e.g. "2500000" for ₦25,000';
export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type ProductStatusValue = (typeof PRODUCT_STATUSES)[number];

export class DimensionsDto {
  @ApiProperty({ example: 300 }) @IsInt() @Min(0) @Max(10_000_000) l!: number;
  @ApiProperty({ example: 200 }) @IsInt() @Min(0) @Max(10_000_000) w!: number;
  @ApiProperty({ example: 100 }) @IsInt() @Min(0) @Max(10_000_000) h!: number;
}

export class MediaItemDto {
  @ApiProperty({ description: 'Key from /products/media/upload-url (new) or an existing media key' }) @IsString() @MaxLength(300) key!: string;
  @ApiProperty({ enum: ['image', 'video'] }) @IsIn(['image', 'video']) type!: 'image' | 'video';
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(200) alt?: string;
}

export class VariantInputDto {
  @ApiPropertyOptional({ description: 'Existing variant id (updates); omit to create' }) @IsOptional() @IsUUID() id?: string;
  @ApiProperty({ example: { Colour: 'Black', Size: 'L' }, description: 'Up to 4 attributes; {} for a simple product' })
  @IsObject() attributes!: Record<string, string>;
  @ApiPropertyOptional({ example: 'BAG001-BLK' }) @IsOptional() @Transform(trim) @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, { message: 'SKU: letters, digits, . _ - (max 64)' }) sku?: string;
  @ApiProperty({ example: '2500000' }) @Matches(KOBO, { message: KOBO_MSG }) priceMinor!: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(KOBO, { message: KOBO_MSG }) promoPriceMinor?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(KOBO, { message: KOBO_MSG }) costPriceMinor?: string | null;
  @ApiPropertyOptional({ description: 'Opening stock for a new variant. Later changes go through inventory adjustments.' })
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) initialStock?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

class ProductFieldsDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(0, 5000) description?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() categoryId?: string | null;
  @ApiPropertyOptional({ enum: PRODUCT_STATUSES }) @IsOptional() @IsIn(PRODUCT_STATUSES) status?: ProductStatusValue;
  @ApiPropertyOptional({ example: 'BAG001', description: 'Leave empty to generate one' })
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, '') : value))
  @Matches(/^[A-Z0-9][A-Z0-9-]{1,19}$/, { message: 'Product code: 2–20 letters, digits or hyphens, e.g. BAG001' }) productCode?: string;
  @ApiPropertyOptional({ example: ['leather', 'new'] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @Length(1, 30, { each: true }) tags?: string[];
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(1_000_000) weightGrams?: number | null;
  @ApiPropertyOptional({ type: DimensionsDto, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @ValidateNested() @Type(() => DimensionsDto) dimensionsMm?: DimensionsDto | null;
  @ApiPropertyOptional({ example: 5 }) @IsOptional() @IsInt() @Min(0) @Max(100_000) lowStockThreshold?: number;
  @ApiPropertyOptional({ type: [MediaItemDto] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => MediaItemDto) media?: MediaItemDto[];
}

export class CreateProductDto extends ProductFieldsDto {
  @ApiProperty({ example: 'Premium Leather Bag' }) @Transform(trim) @IsString() @Length(2, 160) name!: string;
  @ApiProperty({ type: [VariantInputDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => VariantInputDto) variants!: VariantInputDto[];
}

export class UpdateProductDto extends ProductFieldsDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 160) name?: string;
  @ApiPropertyOptional({ type: [VariantInputDto], description: 'Full variant list. Variants left out are deactivated (kept for order history).' })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => VariantInputDto) variants?: VariantInputDto[];
}

export class ListProductsQuery {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(PRODUCT_STATUSES) status?: ProductStatusValue;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsIn(['low', 'out', 'in']) stock?: 'low' | 'out' | 'in';
  @IsOptional() @IsIn(['recent', 'name', 'price_asc', 'price_desc']) sort?: 'recent' | 'name' | 'price_asc' | 'price_desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export const BULK_ACTIONS = ['set_status', 'set_category', 'add_tags', 'remove_tags', 'adjust_price'] as const;

export class BulkUpdateDto {
  @ApiProperty() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) productIds!: string[];
  @ApiProperty({ enum: BULK_ACTIONS }) @IsIn(BULK_ACTIONS) action!: (typeof BULK_ACTIONS)[number];
  @ApiPropertyOptional({ enum: PRODUCT_STATUSES }) @IsOptional() @IsIn(PRODUCT_STATUSES) status?: ProductStatusValue;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() categoryId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @Length(1, 30, { each: true }) tags?: string[];
  @ApiPropertyOptional({ example: -10, description: 'adjust_price: percent change, −90 to +500' }) @IsOptional() @IsInt() @Min(-90) @Max(500) percent?: number;
}

export class ImportProductsDto {
  @ApiProperty({ description: 'CSV text (UTF-8, up to 1,000 rows). Download the export for the column layout.' }) @IsString() @MaxLength(2_000_000) csv!: string;
  @ApiPropertyOptional({ description: 'Validate and report without saving' }) @IsOptional() @IsBoolean() dryRun?: boolean;
}

export class CategoryDto {
  @ApiProperty({ example: 'Bags' }) @Transform(trim) @IsString() @Length(2, 60) name!: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() parentId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 60) name?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() parentId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class MediaUploadDto {
  @ApiProperty({ example: 'image/webp' }) @IsString() @MaxLength(100) contentType!: string;
  @ApiProperty({ example: 182044 }) @IsInt() @Min(1) contentLength!: number;
}
