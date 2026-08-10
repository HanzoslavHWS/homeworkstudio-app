import assert from "node:assert/strict";
import test from "node:test";

import { boothTypes } from "../data/booths.ts";
import { componentCatalog, placeComponent } from "../data/components.ts";
import {
  createCustomerExportData,
  createInternalExportData,
  type ProjectExportSource,
} from "../domain/exports.ts";
import {
  createEmptyNotes,
  notesForEntity,
  updateEntityNotes,
  updateNotes,
} from "../domain/notes.ts";

const booth = boothTypes.find((item) => item.id === "koje-2x2");

if (!booth) {
  throw new Error("Testovací definice Koje 2 × 2 nebyla nalezena.");
}

test("projekt má vlastní internal/customer note", () => {
  const notes = updateNotes(
    updateNotes(createEmptyNotes(), "internalNote", "Interní projekt"),
    "customerNote",
    "Projekt pro zákazníka",
  );

  assert.equal(notes.internalNote, "Interní projekt");
  assert.equal(notes.customerNote, "Projekt pro zákazníka");
});

test("dvě projektové instance stejné typovky nesdílejí poznámky", () => {
  const firstAssemblyNotes = updateNotes(
    createEmptyNotes(),
    "internalNote",
    "První realizace",
  );
  const secondAssemblyNotes = createEmptyNotes();

  assert.notEqual(firstAssemblyNotes, secondAssemblyNotes);
  assert.equal(firstAssemblyNotes.internalNote, "První realizace");
  assert.equal(secondAssemblyNotes.internalNote, "");
});

test("konstrukční element má vlastní project-specific poznámku", () => {
  const firstProjectNotes = updateEntityNotes(
    {},
    "back-wall",
    "customerNote",
    "Stěna projektu A",
  );
  const secondProjectNotes = {};

  assert.equal(
    notesForEntity(firstProjectNotes, "back-wall").customerNote,
    "Stěna projektu A",
  );
  assert.equal(
    notesForEntity(secondProjectNotes, "back-wall").customerNote,
    "",
  );
});

test("systemLocked konstrukční element dovoluje změnit poznámku", () => {
  const backWall = booth.constructionParts.find(
    (part) => part.id === "back-wall",
  );

  assert.ok(backWall?.systemLocked);

  const notes = updateEntityNotes(
    {},
    backWall.id,
    "internalNote",
    "Montážní poznámka",
  );

  assert.equal(
    notesForEntity(notes, backWall.id).internalNote,
    "Montážní poznámka",
  );
});

function exportSource(): ProjectExportSource {
  const component = {
    ...placeComponent(componentCatalog.chair, "chair-notes-export", 1000, 1500),
    internalNote: "Interní mobiliář",
    customerNote: "Mobiliář pro zákazníka",
  };

  return {
    project: {
      internalNote: "Interní projekt",
      customerNote: "Projekt pro zákazníka",
      fairId: "for-beauty-autumn-2026",
      company: "Studio",
      contact: "kontakt@example.test",
      currency: "CZK",
      realizationProfileId: "default",
    },
    booth: {
      internalNote: "Interní sestava",
      customerNote: "Sestava pro zákazníka",
      id: booth.id,
      name: booth.name,
      constructionParts: [
        {
          id: "back-wall",
          name: "Zadní stěna",
          internalNote: "Interní konstrukce",
          customerNote: "Konstrukce pro zákazníka",
        },
      ],
    },
    components: [component],
  };
}

function containsKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (key in value) {
    return true;
  }

  return Object.values(value).some((child) => containsKey(child, key));
}

test("customer export neobsahuje žádný internalNote z žádné úrovně", () => {
  const exported = createCustomerExportData(exportSource());

  assert.equal(containsKey(exported, "internalNote"), false);
});

test("customer export obsahuje customerNote projektu, konstrukce i mobiliáře", () => {
  const exported = createCustomerExportData(exportSource());

  assert.equal(exported.project.customerNote, "Projekt pro zákazníka");
  assert.equal(
    exported.booth.constructionParts[0]?.customerNote,
    "Konstrukce pro zákazníka",
  );
  assert.equal(
    exported.components[0]?.customerNote,
    "Mobiliář pro zákazníka",
  );
});

test("internal export obsahuje obě varianty poznámek na všech úrovních", () => {
  const exported = createInternalExportData(exportSource());

  assert.equal(exported.project.internalNote, "Interní projekt");
  assert.equal(exported.project.customerNote, "Projekt pro zákazníka");
  assert.equal(exported.booth.internalNote, "Interní sestava");
  assert.equal(exported.booth.customerNote, "Sestava pro zákazníka");
  assert.equal(
    exported.booth.constructionParts[0]?.internalNote,
    "Interní konstrukce",
  );
  assert.equal(exported.components[0]?.internalNote, "Interní mobiliář");
  assert.equal(
    exported.components[0]?.customerNote,
    "Mobiliář pro zákazníka",
  );
});
