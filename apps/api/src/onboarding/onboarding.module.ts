import { Module } from '@nestjs/common';
import { AdminVerificationController, OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  controllers: [OnboardingController, AdminVerificationController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
