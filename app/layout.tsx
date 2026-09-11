import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies, headers } from "next/headers";
import { UI_LOCALE_COOKIE, resolveUiLocale } from "../lib/ui-locale";
import "./globals.css";
import { UiLocaleProvider } from "./ui-locale";
import { AppSettingsProvider } from "./app-settings";
import { THEME_INIT_SCRIPT } from "../lib/theme";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const description = "Translate books and read the original and translation side by side, with your library stored locally.";
  return {
    metadataBase: new URL(origin),
    title: "Verso — Read beyond language",
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "Verso — Read beyond language",
      description,
      type: "website",
      url: origin,
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "Verso parallel reading interface" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Verso — Read beyond language",
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
    <html lang={locale} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /></head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <UiLocaleProvider initialLocale={locale}><AppSettingsProvider>{children}</AppSettingsProvider></UiLocaleProvider>
      </body>
    </html>
  );
}
