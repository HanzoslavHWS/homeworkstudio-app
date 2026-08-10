import type { Notes } from "../../domain/models";
import type { NoteField } from "../../domain/notes";

type NotesEditorProps = {
  title?: string;
  notes: Notes;
  className?: string;
  onChange: (field: NoteField, value: string) => void;
};

export function NotesEditor({
  title,
  notes,
  className = "",
  onChange,
}: NotesEditorProps) {
  return (
    <div className={["notesEditor", className].filter(Boolean).join(" ")}>
      {title && <span className="notesEditorTitle">{title}</span>}

      <label className="notesField">
        <span>
          <strong>Interní poznámka</strong>
          <small>Pouze interně</small>
        </span>
        <textarea
          rows={2}
          value={notes.internalNote}
          onChange={(event) => onChange("internalNote", event.target.value)}
          placeholder="Interní informace"
        />
      </label>

      <label className="notesField">
        <span>
          <strong>Poznámka pro zákazníka</strong>
          <small>Viditelná v zákaznickém výstupu</small>
        </span>
        <textarea
          rows={2}
          value={notes.customerNote}
          onChange={(event) => onChange("customerNote", event.target.value)}
          placeholder="Informace určená zákazníkovi"
        />
      </label>
    </div>
  );
}
