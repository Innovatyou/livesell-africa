/*
  Warnings:

  - Added the required column `interval` to the `subscription_invoices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `kind` to the `subscription_invoices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `plan_id` to the `subscription_invoices` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('TRIAL_CONVERSION', 'RENEWAL', 'UPGRADE', 'REACTIVATION');

-- CreateEnum
CREATE TYPE "SubscriptionEventType" AS ENUM ('TRIAL_STARTED', 'PLAN_CHANGED', 'UPGRADE_REQUESTED', 'DOWNGRADE_SCHEDULED', 'PENDING_CHANGE_CANCELLED', 'CANCEL_SCHEDULED', 'RESUMED', 'INVOICE_ISSUED', 'INVOICE_VOIDED', 'INVOICE_PAID', 'TRIAL_ENDED', 'RENEWAL_DUE', 'EXPIRED', 'CANCELLED', 'REACTIVATED', 'REMINDER_SENT');

-- CreateEnum
CREATE TYPE "BusinessVerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "staff_invitations" ADD COLUMN     "accepted_at" TIMESTAMP(3),
ADD COLUMN     "accepted_by" UUID;

-- AlterTable
ALTER TABLE "subscription_invoices" ADD COLUMN     "description" TEXT,
ADD COLUMN     "interval" "BillingInterval" NOT NULL,
ADD COLUMN     "kind" "InvoiceKind" NOT NULL,
ADD COLUMN     "plan_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "ended_at" TIMESTAMP(3),
ADD COLUMN     "pending_interval" "BillingInterval",
ADD COLUMN     "pending_plan_id" UUID;

-- AlterTable
ALTER TABLE "verification_tokens" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "business_verifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "BusinessVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "registered_name" TEXT NOT NULL,
    "registration_type" TEXT NOT NULL,
    "registration_number" TEXT NOT NULL,
    "document_key" TEXT NOT NULL,
    "submitted_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "type" "SubscriptionEventType" NOT NULL,
    "from_plan_id" UUID,
    "to_plan_id" UUID,
    "invoice_id" UUID,
    "dedupe_key" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "actor_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "business_verifications_tenant_id_created_at_idx" ON "business_verifications"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "business_verifications_status_created_at_idx" ON "business_verifications"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_events_dedupe_key_key" ON "subscription_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "subscription_events_tenant_id_created_at_idx" ON "subscription_events"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "subscription_events_subscription_id_created_at_idx" ON "subscription_events"("subscription_id", "created_at");

-- CreateIndex
CREATE INDEX "staff_invitations_tenant_id_email_idx" ON "staff_invitations"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "subscription_invoices_subscription_id_status_idx" ON "subscription_invoices"("subscription_id", "status");

-- AddForeignKey
ALTER TABLE "business_verifications" ADD CONSTRAINT "business_verifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_pending_plan_id_fkey" FOREIGN KEY ("pending_plan_id") REFERENCES "subscription_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
