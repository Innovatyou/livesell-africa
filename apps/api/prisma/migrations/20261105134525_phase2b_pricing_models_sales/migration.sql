-- CreateEnum
CREATE TYPE "PricingModel" AS ENUM ('SUBSCRIPTION', 'COMMISSION');

-- CreateEnum
CREATE TYPE "SalesInquiryStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'CLOSED');

-- AlterEnum
ALTER TYPE "SubscriptionEventType" ADD VALUE 'RENEWED';

-- AlterTable
ALTER TABLE "subscription_plans" ADD COLUMN     "commission_bps" INTEGER,
ADD COLUMN     "pricing_model" "PricingModel" NOT NULL DEFAULT 'SUBSCRIPTION';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "privacy_version" TEXT,
ADD COLUMN     "terms_version" TEXT;

-- CreateTable
CREATE TABLE "sales_inquiries" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "business_name" TEXT NOT NULL,
    "plan_interest" TEXT,
    "monthly_orders" TEXT,
    "message" TEXT NOT NULL,
    "status" "SalesInquiryStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "handled_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_inquiries_status_created_at_idx" ON "sales_inquiries"("status", "created_at");

-- CreateIndex
CREATE INDEX "sales_inquiries_email_idx" ON "sales_inquiries"("email");
