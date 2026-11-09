-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "sms_opt_out" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "whatsapp_opt_out_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "tracking_token_enc" TEXT;

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_conversations" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "tenant_id" UUID,
    "state" TEXT NOT NULL DEFAULT 'IDLE',
    "data" JSONB NOT NULL DEFAULT '{}',
    "last_inbound_at" TIMESTAMP(3) NOT NULL,
    "inbound_count" INTEGER NOT NULL DEFAULT 0,
    "window_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "window_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_inbound_events" (
    "id" UUID NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROCESSED',
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_inbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_events_processed_at_created_at_idx" ON "outbox_events"("processed_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_tenant_id_entity_id_idx" ON "outbox_events"("tenant_id", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_tenant_id_key" ON "notification_preferences"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_conversations_phone_key" ON "whatsapp_conversations"("phone");

-- CreateIndex
CREATE INDEX "whatsapp_conversations_tenant_id_idx" ON "whatsapp_conversations"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_inbound_events_delivery_id_key" ON "whatsapp_inbound_events"("delivery_id");

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Business events are evidence: append-only (processing marks processed_at/attempts/error only).
CREATE OR REPLACE FUNCTION outbox_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'outbox_events rows cannot be deleted'; END IF;
  IF NEW.type IS DISTINCT FROM OLD.type OR NEW.entity_id IS DISTINCT FROM OLD.entity_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'outbox_events are append-only';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER outbox_events_append_only BEFORE UPDATE OR DELETE ON outbox_events FOR EACH ROW EXECUTE FUNCTION outbox_events_guard();
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_phone_e164" CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$');
