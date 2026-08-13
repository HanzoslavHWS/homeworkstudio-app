export class ConcurrencyConflictError extends Error {
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super("Data byla mezitím změněna jinde. Obnovte stránku před uložením.");
    this.name = "ConcurrencyConflictError";
    this.entity = entity;
    this.id = id;
  }
}
