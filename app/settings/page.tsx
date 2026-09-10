import { SettingsScreen } from "./settings-screen";

export default async function SettingsPage({ searchParams }: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const { returnTo } = await searchParams;
  let backHref = "/";
  if (typeof returnTo === "string") {
    const url = URL.parse(returnTo, "http://verso.local");
    if (url && url.origin === "http://verso.local" && url.pathname === "/") {
      const book = url.searchParams.get("book");
      const page = Number(url.searchParams.get("page"));
      if (book) {
        const query = new URLSearchParams({ book });
        if (Number.isSafeInteger(page) && page > 0) query.set("page", String(page));
        backHref = `/?${query}`;
      }
    }
  }
  return <SettingsScreen backHref={backHref} />;
}
