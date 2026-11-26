"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Dictionary } from "@/lib/i18n";

import type { CommunicationFormState } from "./actions";

type Copy = Pick<Dictionary["actionDetail"],
  "resolutionDecision" | "resolutionUnresolved" | "resolutionDelivered" | "resolutionNotDelivered" |
  "resolutionEvidence" | "resolutionNoEvidence" | "resolutionIncident" | "resolutionKeepIncident" |
  "resolutionReason" | "resolutionSave" | "updatingEllipsis"
>;

export function DeliveryResolutionForm({ action, copy, evidence, incidents }: {
  action: (state: CommunicationFormState, data: FormData) => Promise<CommunicationFormState>;
  copy: Copy;
  evidence: { id: string; outcome: "ACCEPTED" | "DELIVERED" | "NOT_DELIVERED" | "INCONCLUSIVE" }[];
  incidents: { id: string; providerEventId: string }[];
}) {
  const [state, submit, pending] = useActionState(action, null);
  return (
    <form action={submit} className="mt-3 flex flex-col gap-2 text-sm">
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <label className="flex flex-col gap-1">
        {copy.resolutionDecision}
        <select name="decision" className="rounded border border-border bg-background p-2">
          <option value="UNRESOLVED">{copy.resolutionUnresolved}</option>
          {evidence.some((event) => event.outcome === "DELIVERED") ?
            <option value="CONFIRMED_DELIVERED">{copy.resolutionDelivered}</option> : null}
          {evidence.some((event) => event.outcome === "NOT_DELIVERED") ?
            <option value="CONFIRMED_NOT_DELIVERED">{copy.resolutionNotDelivered}</option> : null}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        {copy.resolutionEvidence}
        <select name="evidenceEventId" className="rounded border border-border bg-background p-2">
          <option value="">{copy.resolutionNoEvidence}</option>
          {evidence.filter((event) => event.outcome === "DELIVERED" || event.outcome === "NOT_DELIVERED").map((event) => (
            <option key={event.id} value={event.id}>
              {event.outcome === "DELIVERED" ? copy.resolutionDelivered : copy.resolutionNotDelivered} · {event.id}
            </option>
          ))}
        </select>
      </label>
      {incidents.length ? (
        <label className="flex flex-col gap-1">
          {copy.resolutionIncident}
          <select name="incidentId" className="rounded border border-border bg-background p-2">
            <option value="">{copy.resolutionKeepIncident}</option>
            {incidents.map((incident) => (
              <option key={incident.id} value={incident.id}>{incident.id} · {incident.providerEventId}</option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="flex flex-col gap-1">
        {copy.resolutionReason}
        <textarea name="reason" required maxLength={1000} rows={2} className="rounded border border-border bg-background p-2" />
      </label>
      <Button type="submit" disabled={pending} variant="outline" className="self-start">
        {pending ? copy.updatingEllipsis : copy.resolutionSave}
      </Button>
    </form>
  );
}
