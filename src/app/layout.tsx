import type { Metadata } from "next";
import "./globals.css";

import { CookieConsentBanner } from "@/components/cookie-consent-banner";
import { getCookieConsent } from "@/lib/privacy/get-cookie-consent";

export const metadata: Metadata = {
  title: "PAYNORA AI",
  description:
    "PAYNORA AI — accounts receivable and collections automation for small B2B service businesses.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const cookieConsent = await getCookieConsent();

  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">
        {children}
        <CookieConsentBanner initialConsent={cookieConsent} />
      </body>
    </html>
  );
}
