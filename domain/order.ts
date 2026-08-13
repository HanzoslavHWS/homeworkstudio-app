import type {
  ImportedOrder,
  ImportedOrderLine,
} from "./project.ts";
import type { PlacedComponent } from "./models.ts";
import type { ComponentDefinition } from "./models.ts";
import { matchCatalogItem } from "./catalog.ts";

export type OrderInventoryItem = Readonly<{
  catalogItemId: string;
  name: string;
  ordered: number;
  placed: number;
  remaining: number;
  extra: number;
  difference: number;
  status: "complete" | "remaining" | "over";
}>;

export interface OrderParser {
  readonly id: string;
  supports(file: Pick<File, "name" | "type">): boolean;
  parse(file: File): Promise<readonly ImportedOrderLine[]>;
}

export class AwaitingSampleOrderParser implements OrderParser {
  readonly id = "awaiting-sample";

  supports(): boolean {
    return true;
  }

  async parse(): Promise<readonly ImportedOrderLine[]> {
    return [];
  }
}

export async function createImportedOrder(
  file: File,
  parser: OrderParser = new AwaitingSampleOrderParser(),
  now = new Date().toISOString(),
  catalogItems: readonly ComponentDefinition[] = [],
): Promise<ImportedOrder> {
  const parsedLines = await parser.parse(file);
  const lines = reconcileOrderLines(parsedLines, catalogItems);
  return {
    id: `order-${Date.now()}`,
    fileName: file.name,
    mimeType: file.type,
    importedAt: now,
    parserId: parser.id,
    status: lines.length > 0 ? "parsed" : "awaiting-parser",
    lines,
  };
}

export function reconcileOrderLines(
  lines: readonly ImportedOrderLine[],
  catalogItems: readonly ComponentDefinition[],
): readonly ImportedOrderLine[] {
  return lines.map((line) => {
    if (line.mappingStatus === "ignored" || line.mappedCatalogItemId) {
      return line;
    }
    const match = matchCatalogItem(catalogItems, {
      internalCode: line.sourceCode,
      name: line.sourceName,
    });
    return match
      ? {
          ...line,
          mappedCatalogItemId: match.id,
          mappingStatus: "matched",
          itemType:
            match.catalogItemType === "service"
              ? "service"
              : match.sceneLayer === "furniture"
                ? "furniture"
                : "technical",
        }
      : { ...line, mappingStatus: "unresolved" };
  });
}

export function calculateOrderInventory(
  order: ImportedOrder | undefined,
  sceneObjects: readonly Pick<PlacedComponent, "definitionId">[],
): readonly OrderInventoryItem[] {
  if (!order) return [];

  const grouped = new Map<string, { name: string; ordered: number }>();
  for (const line of order.lines) {
    if (
      line.mappingStatus !== "matched" ||
      !line.mappedCatalogItemId ||
      line.itemType !== "furniture"
    ) {
      continue;
    }
    const current = grouped.get(line.mappedCatalogItemId);
    grouped.set(line.mappedCatalogItemId, {
      name: line.sourceName,
      ordered: (current?.ordered ?? 0) + line.quantity,
    });
  }

  return [...grouped].map(([catalogItemId, item]) => {
    const placed = sceneObjects.filter(
      (sceneObject) => sceneObject.definitionId === catalogItemId,
    ).length;
    const remaining = Math.max(0, item.ordered - placed);
    const extra = Math.max(0, placed - item.ordered);
    return {
      catalogItemId,
      name: item.name,
      ordered: item.ordered,
      placed,
      remaining,
      extra,
      difference: placed - item.ordered,
      status:
        placed > item.ordered
          ? "over"
          : remaining === 0
            ? "complete"
            : "remaining",
    };
  });
}
