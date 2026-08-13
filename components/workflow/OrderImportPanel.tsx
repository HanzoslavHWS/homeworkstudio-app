import { useState, type ChangeEvent } from "react";
import { componentCatalog, componentCatalogItems } from "../../data/components";
import { createImportedOrder } from "../../domain/order";
import type { ImportedOrder, ImportedOrderLine } from "../../domain/project";

type Props = {
  order?: ImportedOrder;
  onChange: (order: ImportedOrder | undefined) => void;
};

export function OrderImportPanel({ order, onChange }: Props) {
  const [quantity, setQuantity] = useState(1);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    onChange(await createImportedOrder(file, undefined, undefined, componentCatalogItems));
    event.target.value = "";
  }

  function addMappedChairLine() {
    const line: ImportedOrderLine = {
      id: `line-${Date.now()}`,
      sourceCode: componentCatalog.chair.internalCode ?? "M57",
      sourceName: componentCatalog.chair.displayName ?? componentCatalog.chair.name,
      quantity: Math.max(1, quantity),
      unit: "ks",
      rawText: "Ručně mapovaný demonstrační řádek",
      mappedCatalogItemId: componentCatalog.chair.id,
      mappingStatus: "matched",
      itemType: "furniture",
    };
    const now = new Date().toISOString();
    onChange({
      ...(order ?? {
        id: `order-${Date.now()}`,
        fileName: "Ruční zadání",
        mimeType: "application/x-homework-order",
        importedAt: now,
        parserId: "manual-mapping",
        status: "parsed" as const,
        lines: [],
      }),
      status: "parsed",
      lines: [...(order?.lines ?? []), line],
    });
  }

  return (
    <section className="workflowCard compactCard">
      <div className="workflowCardHeader">
        <div><span>IMPORT OBJEDNÁVKY</span><strong>PDF / XLSX</strong></div>
        {order && <button type="button" className="textButton" onClick={() => onChange(undefined)}>Odebrat</button>}
      </div>
      <p className="workflowMuted">
        Importní rozhraní je připravené. Bez vzorového souboru se obsah nehádá a zůstane k ručnímu mapování.
      </p>
      <label className="filePicker">
        <span>Vybrat objednávku</span>
        <input type="file" accept=".pdf,.xlsx,.xls,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={handleFile} />
      </label>
      {order ? (
        <div className="importState">
          <strong>{order.fileName}</strong>
          <span>{order.status === "awaiting-parser" ? "Čeká na konkrétní parser" : `${order.lines.length} řádků`}</span>
        </div>
      ) : <p className="emptyState">Zatím není importovaná objednávka.</p>}
      <div className="manualOrderLine">
        <span>Test zásobníku se skutečnou židlí</span>
        <input type="number" min={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} />
        <button type="button" onClick={addMappedChairLine}>Přidat mapovaný řádek</button>
      </div>
    </section>
  );
}
