import { notFound } from "next/navigation";
import { SeeEditor } from "../../../../components/see/SeeEditor";
import { SeeShell } from "../../../../components/see/SeeShell";
import { SeeValidationError } from "../../../../domain/seeProject";
import { createSeeDeps } from "../../../../lib/see/backend.server";
import { requireSeePageActor } from "../../../../lib/see/pageAuth.server";
import { getEditorProject } from "../../../../lib/see/service.server";

export const metadata = { title: "HWS SEE | Editor projektu" };

export default async function SeeEditorPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  await requireSeePageActor(`/see/projects/${id}`);
  let project;
  try {
    project = await getEditorProject(createSeeDeps(), id);
  } catch (error) {
    if (error instanceof SeeValidationError && error.status === 404) notFound();
    return (
      <SeeShell active="editor">
        <div className="seeBanner seeBannerError">
          Projekt nelze načíst: {error instanceof Error && /nakonfigur/u.test(error.message) ? error.message : "databáze HWS SEE není dostupná."}
        </div>
      </SeeShell>
    );
  }
  return (
    <SeeShell active="editor" wide>
      <SeeEditor initial={project} />
    </SeeShell>
  );
}
