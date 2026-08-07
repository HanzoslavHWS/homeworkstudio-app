import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Homework Studio | Generator",
  description: "Generátor veletržních stánků Homework Studio",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="cs">
      <body>{children}</body>
    </html>
  );
}