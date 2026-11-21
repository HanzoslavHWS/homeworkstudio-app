import Link from "next/link";
import { LocalModeBanner, SeeShell } from "../../components/see/SeeShell";
import { isLocalSeeBackend } from "../../lib/see/backend.server";
import { requireSeePageActor } from "../../lib/see/pageAuth.server";

export const metadata = { title: "HWS SEE" };

export default async function SeeHomePage() {
  const actor = await requireSeePageActor("/see");
  return (
    <SeeShell active="home">
      {isLocalSeeBackend() && <LocalModeBanner />}
      <section className="seeHero">
        <h1>HWS SEE</h1>
        <p>3D prezentace projektů — nahrajte GLB modely a dokumentaci, připravte pohledy a popisky a sdílejte je veřejným odkazem nebo s PINem.</p>
        <span className="seeMuted">Přihlášen: {actor.label}</span>
      </section>
      <div className="seeChoiceGrid">
        <Link href="/see/new" className="seeChoice">
          <strong>Nový projekt</strong>
          <span>Název, popis, až 3 modely GLB a dokumentace PDF/JPG/PNG.</span>
        </Link>
        <Link href="/see/projects" className="seeChoice">
          <strong>Projekty</strong>
          <span>Přehled, editace, publikace, pozastavení a statistiky otevření.</span>
        </Link>
      </div>
    </SeeShell>
  );
}

