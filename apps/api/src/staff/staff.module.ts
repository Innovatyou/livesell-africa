import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { InvitationsController, StaffController } from './staff.controller';
import { StaffService } from './staff.service';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [StaffController, InvitationsController],
  providers: [StaffService],
})
export class StaffModule {}
