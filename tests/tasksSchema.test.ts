import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// =========================================================================================
// Úkoly — migration guards (RLS convention, no duplicate entities, seeds) and source guards for
// the UI wiring (no DOM test library in this repo — same approach as the other module tests).
// =========================================================================================

async function read(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const MIGRATION = "supabase/migrations/20260925120000_tasks.sql";
const TABLES = ["task_categories", "task_recurring_rules", "tasks", "task_history", "stand_checklist_templates", "stand_checklist_entries"];

test("MIGRATION: RLS enabled on every new table with ZERO policies — the project's convention (server-only service-role access), never USING (true)", async () => {
  const sql = await read(MIGRATION);
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`create table ${table} \\(`, "u"), `${table} is created`);
    assert.match(sql, new RegExp(`alter table ${table} enable row level security;`, "u"), `${table} has RLS enabled`);
  }
  assert.doesNotMatch(sql, /create policy/iu);
  assert.doesNotMatch(sql, /using\s*\(\s*true\s*\)/iu);
  assert.doesNotMatch(sql, /grant\s/iu);
});

test("MIGRATION: links reuse existing entities — no duplicate events / companies / users / milestone tables", async () => {
  const sql = await read(MIGRATION);
  assert.match(sql, /event_id text references events \(id\) on delete set null/u);
  assert.match(sql, /realization_company_id text references print_surface_realization_companies \(id\)/u);
  for (const duplicate of ["events", "companies", "users", "stands", "event_milestones", "realization_companies"]) {
    assert.doesNotMatch(sql, new RegExp(`create table ${duplicate} \\(`, "u"), `no parallel ${duplicate} table`);
  }
  assert.match(sql, /is_automatic boolean not null default false/u, "manual vs automatic is recorded");
  assert.match(sql, /automation_key text unique/u, "automatic tasks are deduplicated by key");
});

test("MIGRATION: seeds the 14 requested categories and the 10-item default stand checklist", async () => {
  const sql = await read(MIGRATION);
  for (const name of ["Grafika", "Technika", "Elektrika", "Internet", "Voda / odpad", "Mobiliář", "Konstrukce", "Tisk", "Kontrola", "E-mail", "Klient", "Montáž", "Administrativa", "Ostatní"]) {
    assert.ok(sql.includes(`'${name}'`), `category ${name}`);
  }
  for (const label of ["Konstrukce", "Mobiliář", "Elektrika", "Internet", "Koberec", "Grafika", "Tisková data", "Vizuál potvrzen", "Technické služby umístěné", "Připraveno k montáži"]) {
    assert.ok(sql.includes(`"label": "${label}"`), `checklist item ${label}`);
  }
});

test("MIGRATION: status / priority / source check constraints match the domain enums", async () => {
  const sql = await read(MIGRATION);
  const domain = await read("domain/tasks.ts");
  for (const [constant, column] of [["TASK_STATUSES", "status"], ["TASK_PRIORITIES", "priority"], ["TASK_SOURCE_TYPES", "source_type"]] as const) {
    const values = [...new RegExp(`${constant} = \\[([^\\]]+)\\]`, "u").exec(domain)![1]!.matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]);
    const check = new RegExp(`${column} text not null default '[a-z_]+' check \\(${column} in \\(([^)]+)\\)\\)`, "u").exec(sql);
    assert.ok(check, `${column} check constraint`);
    assert.deepEqual([...check![1]!.matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]), values, `${column} values match ${constant}`);
  }
});

test("UI: sidebar has Úkoly with the attention badge; BoothGenerator hosts the page, the shared dialog/detail and the badge", async () => {
  const sidebar = await read("components/AppSidebar.tsx");
  assert.match(sidebar, /onNavigate\?\.\("tasks"\)/u);
  assert.match(sidebar, /<span className="navLabel">Úkoly<\/span>/u);
  assert.match(sidebar, /className="navBadge"/u);
  const shell = await read("components/BoothGenerator.tsx");
  assert.match(shell, /taskBadge=\{taskStore\.tasks \? computeTaskCounts\(taskStore\.tasks, localIsoDate\(\)\)\.attention : undefined\}/u);
  assert.match(shell, /\{workspaceSection === "tasks" && \(\s*<TasksPage/u);
  assert.match(shell, /<TaskEditorDialog/u);
  assert.match(shell, /<TaskDetailPanel/u);
  assert.match(shell, /onCreateTask=\{\(\) => openTaskCreate\(workspaceSection === "project" \? boothProjectTaskContext\(\) : undefined\)\}/u, "global + Úkol pre-fills from the open stand");
});

test("UI: stand detail (step 1) shows StandTasksPanel with the stand's context; event detail shows the Úkoly summary + 'Zobrazit úkoly akce'", async () => {
  const shell = await read("components/BoothGenerator.tsx");
  const stepOne = shell.slice(shell.indexOf('{workspaceSection === "project" && step === 1 && ('), shell.indexOf('{workspaceSection === "project" && step === 2 && ('));
  assert.match(stepOne, /<StandTasksPanel[\s\S]*context=\{boothProjectTaskContext\(\)\}/u);
  assert.match(shell, /renderEventExtras=\{\(eventId\) => \(\s*<EventTasksSummary/u);
  assert.match(shell, /navigateWorkspace\("tasks", \{ tasksIntent: \{ tab: "all", filters: \{ eventId: id \} \} \}\)/u);
  const summary = await read("components/workflow/tasks/EventTasksSummary.tsx");
  for (const label of ["Po termínu", "Dnes", "Čekáme", "Ke kontrole", "Zobrazit úkoly akce"]) assert.ok(summary.includes(label), label);
});

test("UI: Úkoly page has the five clickable counts, the six tabs, the fulltext placeholder and 'Vymazat filtry'", async () => {
  const page = await read("components/workflow/tasks/TasksPage.tsx");
  for (const label of ["Dnes", "Po termínu", "Tento týden", "Čekáme na klienta", "Ke kontrole"]) assert.ok(page.includes(`label: "${label}"`), label);
  const domain = await read("domain/tasks.ts");
  for (const label of ["Dnes", "Všechny úkoly", "Kalendář", "Čekáme na klienta", "Ke kontrole", "Dokončené"]) assert.ok(domain.includes(`label: "${label}"`), label);
  assert.match(page, /placeholder="Hledat úkol, firmu nebo stánek…"/u);
  assert.match(page, />Vymazat filtry</u);
  assert.match(page, /Hotovo ✓/u);
  assert.match(page, />Vrátit zpět</u);
});
