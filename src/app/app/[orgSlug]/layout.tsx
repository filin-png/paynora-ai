import { Header, SignOutButton } from "@/components/app-shell/header";
import { Sidebar } from "@/components/app-shell/sidebar";
import { getDictionary } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/get-locale";
import { signOut } from "@/server/auth/config";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";

/**
 * The authenticated app shell for a specific organization — sidebar +
 * header, both real navigation (see docs/product-ui.md#app-shell). Pure
 * UI chrome: this deliberately re-verifies tenant membership itself
 * (unlike the pre-Phase-7 layout, which left that entirely to each page)
 * only to resolve the organization name/role for display — every page
 * under this layout still calls requireOrganizationMembershipForPage (or
 * the OWNER-only variant) itself before touching any data, so this is a
 * second read, not a second authorization boundary.
 */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const locale = await getLocale();
  const dict = getDictionary(locale);

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar orgSlug={orgSlug} orgName={context.organization.name} role={context.role} dict={dict} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          orgSlug={orgSlug}
          orgName={context.organization.name}
          userEmail={context.user.email}
          userName={context.user.name}
          locale={locale}
          dict={dict}
          signOutForm={
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <SignOutButton />
            </form>
          }
        />
        <main className="ambient-field min-w-0 flex-1 px-4 py-8 sm:px-6 lg:px-10">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
