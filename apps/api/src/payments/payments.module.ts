import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { LedgerService } from '../ledger/ledger.service';
import { OrdersModule } from '../orders/orders.module';
import { AdminReconciliationController, BankTransferController } from './bank-transfer.controller';
import { BankTransferService } from './bank-transfer.service';
import { PaymentProviderRegistry } from './payment-provider';
import { ReconciliationService } from './reconciliation.service';
import { AdminPaymentProvidersController, PaymentsController, PaymentsPublicController } from './payments.controller';
import { PaymentsJobs } from './payments.jobs';
import { PaymentsService } from './payments.service';
import { BachsAdapter } from './bachs.adapter';
import { FlutterwaveAdapter } from './flutterwave.adapter';
import { PaystackAdapter } from './paystack.adapter';
import { DefaultPaymentProviderRegistry } from './provider-registry';

@Module({
  imports: [BillingModule, OrdersModule],
  controllers: [PaymentsController, PaymentsPublicController, AdminPaymentProvidersController, BankTransferController, AdminReconciliationController],
  providers: [
    PaymentsService, BankTransferService, ReconciliationService, PaymentsJobs, LedgerService, PaystackAdapter, FlutterwaveAdapter, BachsAdapter,
    { provide: PaymentProviderRegistry, useClass: DefaultPaymentProviderRegistry },
  ],
  exports: [PaymentsService, BankTransferService],
})
export class PaymentsModule {}
