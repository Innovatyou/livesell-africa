import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { CategoriesController, ProductsController } from './catalog.controller';
import { CategoriesService } from './categories.service';
import { ProductImportService } from './product-import.service';
import { ProductsService } from './products.service';

@Module({
  imports: [BillingModule],
  controllers: [ProductsController, CategoriesController],
  providers: [ProductsService, CategoriesService, ProductImportService],
  exports: [ProductsService],
})
export class CatalogModule {}
