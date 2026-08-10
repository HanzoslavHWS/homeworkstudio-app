import type { Notes } from "./models.ts";

export type NoteField = keyof Notes;
export type NotesByEntityId = Readonly<Record<string, Notes>>;

export function createEmptyNotes(): Notes {
  return {
    internalNote: "",
    customerNote: "",
  };
}

export function updateNotes(
  notes: Notes,
  field: NoteField,
  value: string,
): Notes {
  return notes[field] === value
    ? notes
    : { ...notes, [field]: value };
}

export function notesForEntity(
  notesById: NotesByEntityId,
  entityId: string,
): Notes {
  return notesById[entityId] ?? createEmptyNotes();
}

export function updateEntityNotes(
  notesById: NotesByEntityId,
  entityId: string,
  field: NoteField,
  value: string,
): NotesByEntityId {
  return {
    ...notesById,
    [entityId]: updateNotes(
      notesForEntity(notesById, entityId),
      field,
      value,
    ),
  };
}
