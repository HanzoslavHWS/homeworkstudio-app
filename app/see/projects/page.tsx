import { SeeProjects } from "../../../components/see/SeeProjects";
import { LocalModeBanner, SeeShell } from "../../../components/see/SeeShell";
import { isLocalSeeBackend } from "../../../lib/see/backend.server";
import { requireSeePageActor } from "../../../lib/see/pageAuth.server";

export const metadata = { title: "HWS SEE | Projekty" };

export default async function SeeProjectsPage() {
  await requireSeePageActor("/see/projects");
  return (
    <SeeShell active="projects" wide>
      {isLocalSeeBackend() && <LocalModeBanner />}
      <SeeProjects />
    </SeeShell>
  );
}
