import type { Metadata } from "next";
import { resolveAppEnvironment, supabaseProjectRef } from "../lib/env/supabaseEnvironment";
import "./app.css";

// Production (NEXT_PUBLIC_APP_ENV unset or "production") renders exactly as before: no badge, same title.
const appEnvironment = resolveAppEnvironment({ NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV, NODE_ENV: process.env.NODE_ENV });
const isNonProduction = appEnvironment !== "production";

export const metadata: Metadata = {
  title: isNonProduction ? `[${appEnvironment.toUpperCase()}] Homework Studio | Generator` : "Homework Studio | Generator",
  description: "Generátor veletržních stánků Homework Studio",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Server-rendered: the database ref is an identifier, never a credential.
  const databaseRef = isNonProduction ? supabaseProjectRef(process.env.SUPABASE_URL) ?? "nenastaveno" : undefined;
  return (
    <html lang="cs">
      <body>
        {isNonProduction && (
          <div className="appEnvironmentBadge" role="note" title="Vývojové prostředí — data se neukládají do produkce">
            {appEnvironment === "preview" ? "PREVIEW" : "DEV"} · DB {databaseRef}
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
