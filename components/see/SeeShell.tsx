import Link from "next/link";

export function SeeCubeIcon({ size = 22 }: Readonly<{ size?: number }>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.8 20.2 7.4v9.2L12 21.2l-8.2-4.6V7.4z" />
      <path d="M3.8 7.4 12 12l8.2-4.6M12 12v9.2" />
    </svg>
  );
}

type Section = "home" | "new" | "projects" | "editor";

/** Module chrome: brand, the two module entries (Nový projekt / Projekty) and the way back to the portal. */
export function SeeShell({ active, children, wide = false }: Readonly<{ active: Section; children: React.ReactNode; wide?: boolean }>) {
  return (
    <div className="seeShell">
      <header className="seeTopbar">
        <Link href="/see" className="seeBrand">
          <SeeCubeIcon />
          <span>HWS SEE</span>
        </Link>
        <nav className="seeNav" aria-label="HWS SEE">
          <Link href="/see/new" className={active === "new" ? "seeNavActive" : ""}>Nový projekt</Link>
          <Link href="/see/projects" className={active === "projects" || active === "editor" ? "seeNavActive" : ""}>Projekty</Link>
        </nav>
        <Link href="/" className="seeBackToPortal">Portál</Link>
      </header>
      <main className={wide ? "seeMain seeMainWide" : "seeMain"}>{children}</main>
    </div>
  );
}

export function LocalModeBanner() {
  return (
    <div className="seeBanner seeBannerWarn">
      Lokální vývojový režim (SEE_BACKEND=local): data a soubory jsou jen v&nbsp;<code>.see-local/</code> na tomto počítači, nic se neukládá do produkční databáze ani R2.
    </div>
  );
}
