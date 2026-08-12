import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { getAutomationHealth } from "@/server/collections/health";
import { verifyCronSecret } from "@/server/collections/scheduler-auth";

/**
 * A machine-readable operational status surface for the automation
 * scheduler — see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-4. Never
 * triggers a tick, never a live vendor probe — purely reads the durable
 * `AutomationTickRun` heartbeat (src/server/collections/health.ts).
 *
 * Gated by the same bearer secret as `POST /internal/automation/tick`
 * (not a separate one — this is read-only operational metadata about the
 * *same* internal automation surface, not a new capability), so an
 * external monitoring/alerting tool (UptimeRobot, Healthchecks.io, a
 * custom probe) can poll it the same way a scheduler triggers a tick. HTTP
 * status reflects readiness (200 when ready, 503 when not) so a simple
 * status-code-only monitor works out of the box; the JSON body carries
 * the richer detail for anything that wants it. Never includes customer
 * data, message content, or provider secrets — see
 * src/server/collections/health.ts's `AutomationHealth` type, which has
 * no field any of those could occupy.
 */
export async function GET(request: Request): Promise<Response> {
  if (!env.AUTOMATION_CRON_SECRET) {
    return NextResponse.json({ error: "Automation is not enabled for this deployment" }, { status: 503 });
  }
  if (!verifyCronSecret(request.headers.get("authorization"), env.AUTOMATION_CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const health = await getAutomationHealth();
  return NextResponse.json(health, { status: health.ready ? 200 : 503 });
}
