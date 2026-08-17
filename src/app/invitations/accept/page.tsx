import { AuthLayout } from "@/components/auth/auth-layout";
import { Alert } from "@/components/ui/alert";
import { getSessionUser } from "@/server/auth/session";
import { previewInvitation } from "@/server/tenancy/invitations";
import { AcceptInvitationView } from "./accept-invitation-view";

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token: rawToken } = await searchParams;
  const token = Array.isArray(rawToken) ? (rawToken[0] ?? "") : (rawToken ?? "");

  const preview = token ? await previewInvitation(token) : null;
  const user = token ? await getSessionUser() : null;

  if (!preview) {
    return (
      <AuthLayout>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Invalid invitation</h1>
          <Alert tone="danger" className="mt-8">
            This invitation link is invalid or has expired. Ask the organization owner to send a new one.
          </Alert>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AcceptInvitationView
        token={token}
        organizationName={preview.organizationName}
        roleLabel={preview.role === "OWNER" ? "an owner" : "a member"}
        invitedEmail={preview.email}
        signedInEmail={user?.email ?? null}
      />
    </AuthLayout>
  );
}
