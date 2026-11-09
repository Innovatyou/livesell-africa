-- AlterTable
ALTER TABLE "business_verifications" ADD COLUMN     "automated_check" JSONB,
ADD COLUMN     "automated_checked_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "dedupe_key" TEXT,
ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "next_attempt_at" TIMESTAMP(3),
ADD COLUMN     "retryable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sent_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_status_next_attempt_at_idx" ON "notifications"("status", "next_attempt_at");


-- Integrity backstops for messaging usage and attempts.
ALTER TABLE "notification_usage" ADD CONSTRAINT "notification_usage_cost_nonneg" CHECK ("cost_minor" >= 0);
ALTER TABLE "notification_usage" ADD CONSTRAINT "notification_usage_period_fmt" CHECK ("billed_period" ~ '^[0-9]{4}-[0-9]{2}$');
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_attempts_nonneg" CHECK ("attempts" >= 0);
