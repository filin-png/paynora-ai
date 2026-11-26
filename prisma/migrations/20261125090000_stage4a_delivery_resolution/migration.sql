-- Stage 4A. Reviewed SQL draft; apply only after explicit authorization.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "communications" c
    LEFT JOIN "delivery_attempts" a ON c.id = a."communicationId"
    JOIN "invoices" i ON i.id = c."invoiceId"
    JOIN "customers" u ON u.id = c."customerId"
    JOIN "action_proposals" p ON p.id = c."actionProposalId"
    WHERE a."organizationId" <> c."organizationId"
       OR i."organizationId" <> c."organizationId"
       OR u."organizationId" <> c."organizationId"
       OR p."organizationId" <> c."organizationId"
       OR i."customerId" IS DISTINCT FROM c."customerId"
       OR p."invoiceId" IS DISTINCT FROM c."invoiceId"
       OR p."customerId" IS DISTINCT FROM c."customerId"
  ) THEN
    RAISE EXCEPTION 'Stage 4A requires consistent delivery tenant links';
  END IF;
END;
$$;

-- CreateEnum
CREATE TYPE "DeliveryResolutionDecision" AS ENUM ('CONFIRMED_DELIVERED', 'CONFIRMED_NOT_DELIVERED', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "DeliveryEvidenceSource" AS ENUM ('WEBHOOK', 'PROVIDER_LOOKUP', 'TRANSPORT');

-- CreateEnum
CREATE TYPE "DeliveryEvidenceOutcome" AS ENUM ('ACCEPTED', 'DELIVERED', 'NOT_DELIVERED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "DeliveryIncidentKind" AS ENUM ('LATE_DELIVERY_CONTRADICTION');

-- CreateEnum
CREATE TYPE "DeliveryIncidentStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityEventType" ADD VALUE 'DELIVERY_PROVIDER_EVIDENCE_RECORDED';
ALTER TYPE "ActivityEventType" ADD VALUE 'DELIVERY_RESOLUTION_RECORDED';
ALTER TYPE "ActivityEventType" ADD VALUE 'DELIVERY_INCIDENT_OPENED';
ALTER TYPE "ActivityEventType" ADD VALUE 'DELIVERY_INCIDENT_CLOSED';

-- AlterTable
ALTER TABLE "delivery_attempts" ADD COLUMN     "providerAccountRef" TEXT;

-- CreateTable
CREATE TABLE "delivery_provider_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "communicationId" TEXT NOT NULL,
    "deliveryAttemptId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountRef" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "source" "DeliveryEvidenceSource" NOT NULL,
    "outcome" "DeliveryEvidenceOutcome" NOT NULL,
    "evidenceHash" CHAR(64) NOT NULL,
    "evidenceMetadata" JSONB,
    "occurredAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_resolutions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "communicationId" TEXT NOT NULL,
    "deliveryAttemptId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "decision" "DeliveryResolutionDecision" NOT NULL,
    "evidenceEventId" TEXT,
    "operatorId" TEXT NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_incidents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "communicationId" TEXT NOT NULL,
    "deliveryAttemptId" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "priorResolutionId" TEXT NOT NULL,
    "closingResolutionId" TEXT,
    "assignedOperatorId" TEXT,
    "kind" "DeliveryIncidentKind" NOT NULL DEFAULT 'LATE_DELIVERY_CONTRADICTION',
    "status" "DeliveryIncidentStatus" NOT NULL DEFAULT 'OPEN',
    "description" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "delivery_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_event_dedupe_uq" ON "delivery_provider_events"("provider", "providerAccountRef", "source", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_event_scope_uq" ON "delivery_provider_events"("organizationId", "communicationId", "deliveryAttemptId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_resolution_revision_uq" ON "delivery_resolutions"("organizationId", "communicationId", "deliveryAttemptId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_resolution_scope_uq" ON "delivery_resolutions"("organizationId", "communicationId", "deliveryAttemptId", "id");

-- CreateIndex
CREATE INDEX "delivery_incident_guard_idx" ON "delivery_incidents"("organizationId", "communicationId", "status");

-- CreateIndex
CREATE INDEX "delivery_incident_queue_idx" ON "delivery_incidents"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_incident_event_uq" ON "delivery_incidents"("organizationId", "providerEventId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "communication_scope_uq" ON "communications"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempt_scope_uq" ON "delivery_attempts"("organizationId", "communicationId", "id");

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempt_comm_scope_fk" FOREIGN KEY ("organizationId", "communicationId") REFERENCES "communications"("organizationId", "id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "delivery_attempts" VALIDATE CONSTRAINT "delivery_attempt_comm_scope_fk";
ALTER TABLE "delivery_attempts" DROP CONSTRAINT "delivery_attempts_communicationId_fkey";

-- AddForeignKey
ALTER TABLE "delivery_provider_events" ADD CONSTRAINT "delivery_event_org_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "delivery_provider_events" ADD CONSTRAINT "delivery_event_attempt_fk" FOREIGN KEY ("organizationId", "communicationId", "deliveryAttemptId") REFERENCES "delivery_attempts"("organizationId", "communicationId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "delivery_resolutions" ADD CONSTRAINT "delivery_resolution_org_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "delivery_resolutions" ADD CONSTRAINT "delivery_resolution_attempt_fk" FOREIGN KEY ("organizationId", "communicationId", "deliveryAttemptId") REFERENCES "delivery_attempts"("organizationId", "communicationId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "delivery_resolutions" ADD CONSTRAINT "delivery_resolution_evidence_fk" FOREIGN KEY ("organizationId", "communicationId", "deliveryAttemptId", "evidenceEventId") REFERENCES "delivery_provider_events"("organizationId", "communicationId", "deliveryAttemptId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "delivery_resolutions" ADD CONSTRAINT "delivery_resolution_previous_fk" FOREIGN KEY ("organizationId", "communicationId", "deliveryAttemptId", "supersedesId") REFERENCES "delivery_resolutions"("organizationId", "communicationId", "deliveryAttemptId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "delivery_incidents" ADD CONSTRAINT "delivery_incident_org_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "delivery_incidents" ADD CONSTRAINT "delivery_incident_attempt_fk" FOREIGN KEY ("organizationId", "communicationId", "deliveryAttemptId") REFERENCES "delivery_attempts"("organizationId", "communicationId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "delivery_incidents" ADD CONSTRAINT "delivery_incident_event_fk" FOREIGN KEY ("organizationId", "communicationId", "deliveryAttemptId", "providerEventId") REFERENCES "delivery_provider_events"("organizationId", "communicationId", "deliveryAttemptId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "delivery_incidents" ADD CONSTRAINT "delivery_incident_prior_fk" FOREIGN KEY ("organizationId", "communicationId", "deliveryAttemptId", "priorResolutionId") REFERENCES "delivery_resolutions"("organizationId", "communicationId", "deliveryAttemptId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "delivery_incidents" ADD CONSTRAINT "delivery_incident_closure_fk" FOREIGN KEY ("organizationId", "communicationId", "deliveryAttemptId", "closingResolutionId") REFERENCES "delivery_resolutions"("organizationId", "communicationId", "deliveryAttemptId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX "delivery_resolution_successor_uq"
  ON "delivery_resolutions" ("supersedesId") WHERE "supersedesId" IS NOT NULL;

ALTER TABLE "delivery_resolutions"
  ADD CONSTRAINT "delivery_resolution_revision_ck" CHECK (
    ("revision" = 1 AND "supersedesId" IS NULL)
    OR ("revision" > 1 AND "supersedesId" IS NOT NULL AND "supersedesId" <> id)
  ),
  ADD CONSTRAINT "delivery_resolution_reason_ck" CHECK ("reason" ~ '[^[:space:]]'),
  ADD CONSTRAINT "delivery_resolution_evidence_ck" CHECK ("decision" = 'UNRESOLVED' OR "evidenceEventId" IS NOT NULL);

ALTER TABLE "delivery_provider_events"
  ADD CONSTRAINT "delivery_event_hash_ck" CHECK ("evidenceHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "delivery_incidents"
  ADD CONSTRAINT "delivery_incident_closure_ck" CHECK (
    ("status" = 'OPEN' AND "closedAt" IS NULL AND "closingResolutionId" IS NULL)
    OR ("status" = 'CLOSED' AND "closedAt" IS NOT NULL AND "closingResolutionId" IS NOT NULL
      AND "closingResolutionId" <> "priorResolutionId")
  );

-- Insert-only history during the organization's lifetime. AFTER DELETE allows
-- the organization cascade, but rejects independent or indirect child purges.
CREATE FUNCTION public.paynora_delivery_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Delivery history is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER delivery_resolutions_append_only
  AFTER UPDATE OR DELETE ON public.delivery_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.paynora_delivery_history_immutable();
CREATE TRIGGER delivery_provider_events_append_only
  AFTER UPDATE OR DELETE ON public.delivery_provider_events
  FOR EACH ROW EXECUTE FUNCTION public.paynora_delivery_history_immutable();
CREATE TRIGGER delivery_incidents_no_delete
  AFTER DELETE ON public.delivery_incidents
  FOR EACH ROW EXECUTE FUNCTION public.paynora_delivery_history_immutable();

-- TRUNCATE CASCADE fires these triggers as well.
CREATE TRIGGER delivery_resolutions_no_truncate
  BEFORE TRUNCATE ON public.delivery_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION public.paynora_delivery_history_immutable();
CREATE TRIGGER delivery_provider_events_no_truncate
  BEFORE TRUNCATE ON public.delivery_provider_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.paynora_delivery_history_immutable();
CREATE TRIGGER delivery_incidents_no_truncate
  BEFORE TRUNCATE ON public.delivery_incidents
  FOR EACH STATEMENT EXECUTE FUNCTION public.paynora_delivery_history_immutable();

CREATE FUNCTION public.paynora_check_delivery_resolution() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."supersedesId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.delivery_resolutions r
    WHERE r.id = NEW."supersedesId" AND r."organizationId" = NEW."organizationId"
      AND r."communicationId" = NEW."communicationId" AND r."deliveryAttemptId" = NEW."deliveryAttemptId"
      AND r.revision = NEW.revision - 1
  ) THEN
    RAISE EXCEPTION 'Delivery resolution must reference its immediate predecessor' USING ERRCODE = '23514';
  END IF;
  IF NEW."evidenceEventId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.delivery_provider_events e
    WHERE e.id = NEW."evidenceEventId" AND e."organizationId" = NEW."organizationId"
      AND e."communicationId" = NEW."communicationId" AND e."deliveryAttemptId" = NEW."deliveryAttemptId"
      AND (NEW.decision = 'UNRESOLVED'
        OR (NEW.decision = 'CONFIRMED_DELIVERED' AND e.outcome = 'DELIVERED')
        OR (NEW.decision = 'CONFIRMED_NOT_DELIVERED' AND e.outcome = 'NOT_DELIVERED'))
  ) THEN
    RAISE EXCEPTION 'Delivery resolution evidence is inconsistent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_resolution_check_insert
  BEFORE INSERT ON public.delivery_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.paynora_check_delivery_resolution();

CREATE FUNCTION public.paynora_check_delivery_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.delivery_attempts a
    WHERE a.id = NEW."deliveryAttemptId" AND a."organizationId" = NEW."organizationId"
      AND a."communicationId" = NEW."communicationId" AND a.provider = NEW.provider
      AND (
        (NEW.source = 'TRANSPORT'
          AND (NEW.outcome = 'ACCEPTED' OR (NEW.outcome = 'INCONCLUSIVE'
            AND NEW."externalEventId" LIKE 'paynora-conflict:%'
            AND NEW."evidenceMetadata" @> '{"idempotencyConflict": true}'::jsonb))
          AND NEW."providerAccountRef" = COALESCE(a."providerAccountRef", 'attempt:' || a.id))
        OR (NEW.source IN ('WEBHOOK', 'PROVIDER_LOOKUP')
          AND NEW."providerAccountRef" = a."providerAccountRef")
      )
  ) THEN
    RAISE EXCEPTION 'Delivery evidence source does not match the attempt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_provider_event_check_insert
  BEFORE INSERT ON public.delivery_provider_events
  FOR EACH ROW EXECUTE FUNCTION public.paynora_check_delivery_event();

CREATE FUNCTION public.paynora_check_delivery_incident_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status <> 'OPEN' OR NOT EXISTS (
    SELECT 1 FROM public.delivery_provider_events e
    JOIN public.delivery_resolutions r
      ON r."organizationId" = e."organizationId" AND r."communicationId" = e."communicationId"
      AND r."deliveryAttemptId" = e."deliveryAttemptId"
    WHERE e.id = NEW."providerEventId" AND r.id = NEW."priorResolutionId"
      AND e."organizationId" = NEW."organizationId" AND e."communicationId" = NEW."communicationId"
      AND e."deliveryAttemptId" = NEW."deliveryAttemptId"
      AND e.outcome = 'DELIVERED' AND r.decision = 'CONFIRMED_NOT_DELIVERED'
  ) THEN
    RAISE EXCEPTION 'Delivery incident requires contradictory evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_incident_check_insert
  BEFORE INSERT ON public.delivery_incidents
  FOR EACH ROW EXECUTE FUNCTION public.paynora_check_delivery_incident_insert();

CREATE FUNCTION public.paynora_check_delivery_incident_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status <> 'OPEN' OR NEW.status <> 'CLOSED'
    OR (to_jsonb(OLD) - ARRAY['status','closedAt','closingResolutionId']) <>
       (to_jsonb(NEW) - ARRAY['status','closedAt','closingResolutionId'])
    OR NOT EXISTS (
      SELECT 1 FROM public.delivery_resolutions r
      JOIN public.delivery_resolutions p ON p.id = OLD."priorResolutionId"
      WHERE r.id = NEW."closingResolutionId" AND r."organizationId" = OLD."organizationId"
        AND r."communicationId" = OLD."communicationId" AND r."deliveryAttemptId" = OLD."deliveryAttemptId"
        AND r.revision > p.revision AND r.decision = 'CONFIRMED_DELIVERED'
    )
  THEN
    RAISE EXCEPTION 'Delivery incident requires a superseding delivery resolution' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_incident_close_only
  BEFORE UPDATE ON public.delivery_incidents
  FOR EACH ROW EXECUTE FUNCTION public.paynora_check_delivery_incident_update();

-- Administrative organization purge is the only delete path for populated
-- delivery history. The fixture runner may exercise the cascade on the exact
-- designated isolated test server.
CREATE FUNCTION public.paynora_authorize_delivery_org_purge() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.organizations'::regclass))
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
    OR (session_user = 'paynora_test_runner' AND current_user = 'paynora_test_runner'
      AND current_database() = 'paynora_test' AND inet_server_addr() = '127.0.0.1'::inet
      AND inet_server_port() = 55432 AND current_setting('cluster_name', true) = 'paynora_test_isolated')
  THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_resolutions WHERE "organizationId" = OLD.id)
    OR EXISTS (SELECT 1 FROM public.delivery_provider_events WHERE "organizationId" = OLD.id)
    OR EXISTS (SELECT 1 FROM public.delivery_incidents WHERE "organizationId" = OLD.id)
  THEN
    RAISE EXCEPTION 'Delivery history requires administrative organization deletion' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER delivery_authorize_org_purge
  BEFORE DELETE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.paynora_authorize_delivery_org_purge();

COMMIT;
