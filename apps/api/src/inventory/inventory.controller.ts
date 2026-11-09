import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { CurrentTenant, CurrentUser, RequirePermissions } from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { InventoryService } from './inventory.service';

export class AdjustStockDto {
  @ApiProperty({ enum: ['add', 'remove', 'set'], description: 'add/remove a quantity, or set to a counted quantity' })
  @IsIn(['add', 'remove', 'set']) mode!: 'add' | 'remove' | 'set';
  @ApiProperty({ example: 10 }) @IsInt() @Min(0) @Max(1_000_000) quantity!: number;
  @ApiProperty({ example: 'New delivery from supplier' }) @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsString() @Length(2, 200) reason!: string;
  @ApiPropertyOptional({ enum: ['RESTOCK', 'ADJUSTMENT', 'RETURN'] }) @IsOptional() @IsIn(['RESTOCK', 'ADJUSTMENT', 'RETURN']) type?: 'RESTOCK' | 'ADJUSTMENT' | 'RETURN';
}

export class MovementsQuery {
  @IsOptional() @IsUUID() variantId?: string;
  @IsOptional() @IsUUID() productId?: string;
}

@ApiTags('inventory')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ path: 'inventory', version: '1' })
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @RequirePermissions('inventory:write') @Post('variants/:variantId/adjust')
  @ApiOperation({ summary: 'Adjust stock (row-locked; cannot go below units reserved for open orders)' })
  adjust(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('variantId', ParseUUIDPipe) id: string, @Body() dto: AdjustStockDto) {
    return this.inventory.adjust(t.tenantId, u.id, id, dto);
  }

  @RequirePermissions('inventory:read') @Get('movements') @ApiOperation({ summary: 'Stock movement history (latest 50)' })
  movements(@CurrentTenant() t: TenantContext, @Query() q: MovementsQuery) {
    return this.inventory.movements(t.tenantId, q);
  }

  @RequirePermissions('inventory:read') @Get('low-stock') @ApiOperation({ summary: 'Variants at or below their low-stock threshold' })
  lowStock(@CurrentTenant() t: TenantContext) {
    return this.inventory.lowStock(t.tenantId);
  }
}
