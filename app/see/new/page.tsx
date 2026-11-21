import { SeeNewProject } from "../../../components/see/SeeNewProject";
import { LocalModeBanner, SeeShell } from "../../../components/see/SeeShell";
import { readSeeUploadLimits } from "../../../domain/seeFiles";
import { isLocalSeeBackend } from "../../../lib/see/backend.server";
import { requireSeePageActor } from "../../../lib/see/pageAuth.server";

export const metadata = { title: "HWS SEE | Nový projekt" };

export default async function SeeNewProjectPage() {
  await requireSeePageActor("/see/new");
  return (
    <SeeShell active="new">
      {isLocalSeeBackend() && <LocalModeBanner />}
      <SeeNewProject limits={readSeeUploadLimits(process.env)} />
    </SeeShell>
  );
}
