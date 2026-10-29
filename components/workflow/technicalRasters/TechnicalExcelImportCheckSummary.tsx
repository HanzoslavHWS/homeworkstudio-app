"use client";

import type { TechnicalExcelImportCheck } from "../../../domain/technicalReportExcelTable";

function totalsLabel(check: TechnicalExcelImportCheck): Readonly<{ text: string; warn: boolean }> {
  switch (check.totals.status) {
    case "match":
      return { text: "souhlasí s řádkem „Celkem“", warn: false };
    case "mismatch":
      return { text: `NESOUHLASÍ s řádkem „Celkem“ (${check.totals.differences.length} služeb)`, warn: true };
    case "unverifiable":
      return { text: `nelze ověřit — ${check.totals.reason}`, warn: true };
    case "missing":
      return { text: "řádek „Celkem“ v souboru není", warn: false };
  }
}

/** Kontrolní report Excel importu (náhled před potvrzením): odkud se co četlo a zda součty sedí se souborem. */
export function TechnicalExcelImportCheckSummary({ check }: { check: TechnicalExcelImportCheck }) {
  const totals = totalsLabel(check);
  return (
    <details className="technicalImportPreviewDetails" open={totals.warn}>
      <summary>
        Kontrola Excelu — list „{check.sheetName}“, {check.standRowCount} řádků stánků, součty{" "}
        <span className={totals.warn ? "technicalImportPreviewSummaryWarn" : undefined}>{totals.text}</span>
      </summary>
      <ul>
        <li>Hlavička: řádek {check.headerRowNumbers.join(" + ")}; poznámky: {check.noteCount}; řádky bez čísla stánku: {check.rowsWithoutStandCount}</li>
        {check.columns.map((column) => (
          <li key={column.valueColumn}>{column.label} — hodnoty ze sloupce {column.valueColumn}{column.valueColumn !== column.headerColumn ? ` (hlavička ve sloupci ${column.headerColumn})` : ""}</li>
        ))}
      </ul>
    </details>
  );
}
