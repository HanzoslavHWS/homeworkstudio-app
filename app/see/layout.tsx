import type { Metadata } from "next";
import "./see.css";

export const metadata: Metadata = {
  title: "HWS SEE",
  description: "HWS SEE — 3D prezentace projektů Homework Studio",
  robots: { index: false, follow: false },
};

/** Shared by the editor pages and the public /see/p, /see/embed pages: styles only, no auth here. */
export default function SeeLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
