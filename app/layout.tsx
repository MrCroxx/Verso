import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies, headers } from "next/headers";
import { UI_LOCALE_COOKIE, resolveUiLocale } from "../lib/ui-locale";
import "./globals.css";
import { UiLocaleProvider } from "./ui-locale";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const description = "A fast, local-first parallel translator for scanned books.";
  return {
    metadataBase: new URL(origin),
    title: "Verso — AI Parallel Reader",
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "Verso — AI Parallel Reader",
      description,
      type: "website",
      url: origin,
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "Verso parallel reading interface" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Verso — AI Parallel Reader",
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [requestCookies, requestHeaders] = await Promise.all([cookies(), headers()]);
  const locale = resolveUiLocale(
    requestCookies.get(UI_LOCALE_COOKIE)?.value,
    requestHeaders.get("accept-language"),
  );
  return (
    <html lang={locale}>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <UiLocaleProvider initialLocale={locale}>{children}</UiLocaleProvider>
      </body>
    </html>
  );
}
