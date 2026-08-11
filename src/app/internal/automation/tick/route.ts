import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { runAutomationTick } from "@/server/collections/engine";
import { verifyCronSecret } from "@/server/collections/scheduler-auth";

/**
 * Vendor-neutral scheduler adapter boundary (section 32,
 * docs/collections-automation.md#scheduler-deployment). Any scheduler that
 * can make an authenticated HTTPS POST — Vercel Cron, a self-hosted cron,
 * a systemd timer, GitHub Actions on a schedule — can drive automation by
 * calling this endpoint; nothing here or in the domain layer knows or
 * cares which one. Deliberately reads no request body: a global tick has
 * no tenant to select, so there is nothing for a caller to supply that
 * could scope or spoof it (see runAutomationTick's own options.organizationId,
 * used only by the org-scoped dev-only manual trigger Server Action, never
 * reachable from this endpoint).
 */
export async function POST(request: Request): Promise<Response> {
  if (!env.AUTOMATION_ENABLED || !env.AUTOMATION_CRON_SECRET) {
    return NextResponse.json({ error: "Automation is not enabled for this deployment" }, { status: 503 });
  }
  if (!verifyCronSecret(request.headers.get("authorization"), env.AUTOMATION_CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const summary = await runAutomationTick(new Date());
  return NextResponse.json({ summary });
}
