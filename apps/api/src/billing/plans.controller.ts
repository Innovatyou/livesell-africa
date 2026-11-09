import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, RequirePlatformRole } from '../common/auth/decorators';
import type { AuthUser } from '../common/auth/request-context';
import { CreatePlanDto, UpdatePlanDto } from './plans.dto';
import { PlansService } from './plans.service';

@ApiTags('plans')
@Controller({ path: 'plans', version: '1' })
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Public() @Get()
  @ApiOperation({ summary: 'Active public subscription plans (pricing page). Prices are kobo strings; null = custom pricing' })
  list() {
    return this.plans.listPublic();
  }
}

@ApiTags('admin · plans')
@ApiBearerAuth()
@RequirePlatformRole('PLATFORM_ADMIN')
@Controller({ path: 'admin/plans', version: '1' })
export class AdminPlansController {
  constructor(private readonly plans: PlansService) {}

  @Get() @ApiOperation({ summary: 'All plans, including inactive/private, with live subscriber counts' })
  list() {
    return this.plans.listAll();
  }

  @Post() @ApiOperation({ summary: 'Create a plan' })
  create(@Body() dto: CreatePlanDto, @CurrentUser() user: AuthUser) {
    return this.plans.create(dto, user.id);
  }

  @Patch(':id') @ApiOperation({ summary: 'Edit a plan. Price changes apply to invoices issued afterwards; deactivate instead of deleting' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlanDto, @CurrentUser() user: AuthUser) {
    return this.plans.update(id, dto, user.id);
  }
}
