import type { ComponentDefinition, PlacedComponent } from "./models.ts";

export function canResizeComponent(
  component: Pick<ComponentDefinition | PlacedComponent, "resizable">,
): boolean {
  return component.resizable;
}
