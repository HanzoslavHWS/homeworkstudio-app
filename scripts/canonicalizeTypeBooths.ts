/**
 * Type-booth catalog canonicalization — P86 / P87 / T04..T25 (session "KATALOG / DB TYPOVÝCH
 * STÁNKŮ", 2026-08-19). See domain/typeBoothCanonicalization.ts for the pure plan logic.
 *
 *   node scripts/canonicalizeTypeBooths.ts             -> dry-run (DEFAULT, zero writes)
 *   node scripts/canonicalizeTypeBooths.ts --dry-run    -> same, explicit
 *   node scripts/canonicalizeTypeBooths.ts --apply      -> real writes
 *
 * Never touches: pricing (pricingEntries / event pricing_entries / price lists),
 * catalog_mappings, kind, category, or any asset (photoAsset/modelAsset/sourceAssets) — only
 * adds a missing `variants` scaffold to Txx and creates P87 if it is truly absent.
 */
import { createSupabaseServerClient } from "../lib/db/supabase.server.ts";
import { applyCanonicalPlanEntry, readExistingTypeBoothRows } from "../lib/db/typeBoothCanonicalization.supabase.ts";
import { planTypeBoothCatalog, type CanonicalPlanEntry } from "../domain/typeBoothCanonicalization.ts";

function printPlan(plan: readonly CanonicalPlanEntry[]): void {
  for (const entry of plan) {
    console.log(`${entry.internalCode.padEnd(6)} ${entry.action.toUpperCase().padEnd(7)} ${entry.reason}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  console.log(`=== TYPE-BOOTH CANONICALIZATION (P86/P87/Txx) — ${apply ? "APPLY" : "DRY-RUN"} ===\n`);

  const client = createSupabaseServerClient();
  const existing = await readExistingTypeBoothRows(client);
  console.log(`Remote DB (read-only SELECT): ${existing.length} catalog_items.\n`);

  const plan = planTypeBoothCatalog(existing);
  printPlan(plan);

  const writes = plan.filter((entry) => entry.action !== "noop");
  console.log(`\nPlánovaných DB writes: ${writes.length} (create=${writes.filter((e) => e.action === "create").length}, update=${writes.filter((e) => e.action === "update").length})`);

  if (!apply) {
    console.log("\nDRY-RUN — žádné zápisy provedeny. Spusťte s --apply pro aplikaci.");
    return;
  }

  if (writes.length === 0) {
    console.log("\nNIC k aplikaci — už vše canonical (idempotentní no-op).");
    return;
  }

  console.log("\n=== APPLYING ===");
  for (const entry of writes) {
    await applyCanonicalPlanEntry(client, entry);
    console.log(`APPLIED: ${entry.internalCode} (${entry.action})`);
  }

  console.log("\n=== POST-APPLY VERIFY (re-plan proti čerstvě přečtené DB, očekávám samé NOOP) ===");
  const after = await readExistingTypeBoothRows(client);
  const verifyPlan = planTypeBoothCatalog(after);
  printPlan(verifyPlan);

  const stillPending = verifyPlan.filter((entry) => entry.action !== "noop");
  if (stillPending.length > 0) {
    console.error(`\nWARNING: ${stillPending.length} položek stále NENÍ noop po apply — zkontrolujte výše.`);
    process.exitCode = 1;
    return;
  }
  console.log("\nOK — všechny položky NOOP po apply (idempotentní).");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
