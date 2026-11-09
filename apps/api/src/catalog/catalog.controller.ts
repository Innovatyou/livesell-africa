import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser, RequirePermissions } from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { CategoriesService } from './categories.service';
import { ProductImportService } from './product-import.service';
import {
  BulkUpdateDto, CategoryDto, CreateProductDto, ImportProductsDto, ListProductsQuery, MediaUploadDto, UpdateCategoryDto, UpdateProductDto,
} from './products.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ path: 'products', version: '1' })
export class ProductsController {
  constructor(private readonly products: ProductsService, private readonly importer: ProductImportService) {}

  @RequirePermissions('products:read') @Get()
  @ApiOperation({ summary: 'List products with search, status/category/stock filters and pagination' })
  list(@CurrentTenant() t: TenantContext, @Query() q: ListProductsQuery) {
    return this.products.list(t.tenantId, q);
  }

  @RequirePermissions('products:read') @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8') @Header('Content-Disposition', 'attachment; filename="products.csv"')
  @ApiProduces('text/csv') @ApiOperation({ summary: 'Export all products as CSV (one row per variant)' })
  export(@CurrentTenant() t: TenantContext) {
    return this.importer.exportCsv(t.tenantId);
  }

  @RequirePermissions('products:read') @Get('code-suggestion')
  @ApiQuery({ name: 'name' }) @ApiQuery({ name: 'categoryId', required: false })
  @ApiOperation({ summary: 'Suggest the next product code (e.g. BAG004) for a product name / category' })
  suggest(@CurrentTenant() t: TenantContext, @Query('name') name = '', @Query('categoryId') categoryId?: string) {
    return this.products.suggestCode(t.tenantId, name.slice(0, 160), categoryId && /^[0-9a-f-]{36}$/i.test(categoryId) ? categoryId : undefined);
  }

  @RequirePermissions('products:read') @Get('by-code/:code') @ApiOperation({ summary: 'Look up a product by its code (e.g. BAG001)' })
  byCode(@CurrentTenant() t: TenantContext, @Param('code') code: string) {
    return this.products.getByCode(t.tenantId, code.slice(0, 40));
  }

  @RequirePermissions('products:read') @Get(':id')
  get(@CurrentTenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(t.tenantId, id);
  }

  @RequirePermissions('products:write') @Post()
  @ApiOperation({ summary: 'Create a product with variants (counts against the plan product limit)' })
  create(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: CreateProductDto) {
    return this.products.create(t.tenantId, u.id, dto);
  }

  @RequirePermissions('products:write') @Patch(':id')
  @ApiOperation({ summary: 'Update a product; a variants list replaces the variant set (missing ones are deactivated)' })
  update(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(t.tenantId, u.id, id, dto);
  }

  @RequirePermissions('products:write') @Delete(':id') @HttpCode(204)
  @ApiOperation({ summary: 'Delete (archive) a product; kept for order history' })
  async remove(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.products.remove(t.tenantId, u.id, id);
  }

  @RequirePermissions('products:write') @Post('bulk') @HttpCode(200)
  @ApiOperation({ summary: 'Bulk update: status, category, tags or price (percent)' })
  bulk(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: BulkUpdateDto) {
    return this.products.bulk(t.tenantId, u.id, dto);
  }

  @RequirePermissions('products:write') @Post('import') @HttpCode(200)
  @ApiOperation({ summary: 'Import products from CSV (all-or-nothing; dryRun to validate only)' })
  import(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: ImportProductsDto) {
    return this.importer.importCsv(t.tenantId, u.id, dto.csv, dto.dryRun ?? false);
  }

  @RequirePermissions('products:write') @Post('media/upload-url')
  @ApiOperation({ summary: 'Presigned PUT for a product image (PNG/JPG/WebP ≤ 5 MB) or video (MP4/WebM ≤ 50 MB)' })
  mediaUpload(@CurrentTenant() t: TenantContext, @Body() dto: MediaUploadDto) {
    return this.products.presignMedia(t.tenantId, dto.contentType, dto.contentLength);
  }
}

@ApiTags('products')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ path: 'categories', version: '1' })
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @RequirePermissions('products:read') @Get()
  list(@CurrentTenant() t: TenantContext) {
    return this.categories.list(t.tenantId);
  }

  @RequirePermissions('products:write') @Post()
  create(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: CategoryDto) {
    return this.categories.create(t.tenantId, u.id, dto);
  }

  @RequirePermissions('products:write') @Patch(':id')
  update(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(t.tenantId, u.id, id, dto);
  }

  @RequirePermissions('products:write') @Delete(':id') @HttpCode(204)
  async remove(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.categories.remove(t.tenantId, u.id, id);
  }
}
