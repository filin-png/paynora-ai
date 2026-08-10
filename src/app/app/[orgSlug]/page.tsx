import { listOrganizationMembers } from "@/server/tenancy/organizations";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { RenameOrganizationForm } from "./rename-organization-form";

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const members = await listOrganizationMembers(context.organization.id);

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {context.organization.name}
        </h1>
        <p className="mt-1 text-sm text-muted">Your role: {context.role}</p>
      </div>

      <div>
        <h2 className="text-sm font-semibold">Members</h2>
        <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
          {members.map((member) => (
            <li
              key={member.userId}
              className="flex items-center justify-between px-4 py-3 text-sm"
            >
              <span>{member.name ?? member.email}</span>
              <span className="text-xs text-muted">{member.role}</span>
            </li>
          ))}
        </ul>
      </div>

      {context.role === "OWNER" ? (
        <div>
          <h2 className="text-sm font-semibold">Organization settings</h2>
          <RenameOrganizationForm
            orgSlug={orgSlug}
            currentName={context.organization.name}
          />
        </div>
      ) : null}
    </div>
  );
}
