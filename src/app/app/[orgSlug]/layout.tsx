import Link from "next/link";

/**
 * Pure UI chrome — deliberately does not itself verify tenant membership.
 * Every page under this layout calls requireOrganizationMembershipForPage
 * (or the OWNER-only variant) itself; duplicating that check here would
 * only add a redundant query, not additional protection.
 */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const base = `/app/${orgSlug}`;

  const navItems = [
    { href: base, label: "Dashboard" },
    { href: `${base}/customers`, label: "Customers" },
    { href: `${base}/invoices`, label: "Invoices" },
    { href: `${base}/settings`, label: "Settings" },
  ];

  return (
    <div className="flex flex-col gap-8">
      <nav className="flex gap-6 border-b border-border pb-4 text-sm font-medium text-muted">
        {navItems.map((item) => (
          <Link key={item.href} href={item.href} className="hover:text-foreground">
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
