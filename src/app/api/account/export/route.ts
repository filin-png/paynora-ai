import { NextResponse } from "next/server";

import { getSessionUser } from "@/server/auth/session";
import { exportUserData } from "@/server/auth/data-export";

/**
 * "Export my data" (Phase 15A, docs/privacy-policy.md#16-user-rights) —
 * session-authenticated, scoped to the requesting user's own account
 * data only. See src/server/auth/data-export.ts for exactly what is and
 * is not included, and why.
 */
export async function GET(): Promise<Response> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const data = await exportUserData(user.id);

  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": "attachment; filename=\"paynora-account-export.json\"",
    },
  });
}
