// Phase 2: optional parent, milestone and sequence mappings, Project Operations defaults, hierarchy and summary bars.
const assert = require("assert");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadSource } = require("./helpers/loadTs");
const { CUSTOM_COLUMNS, HIERARCHY_COLUMNS, PROJECT_TASK_COLUMNS, makeDataset, makeContext, installWindowStub } = require("./helpers/mockDataset");

installWindowStub();
const { TaskGantt } = loadSource("index.ts");
const { Gantt, milestoneDate } = loadSource("src/Gantt.tsx");
const { resolveFieldMap, buildLayout, mapRecord, toParentRef, toFlag, toSequence, hasHierarchy } = loadSource("src/fieldMap.ts");
const { buildHierarchy, summarySpan, visibleRows } = loadSource("src/hierarchy.ts");

const noop = () => {};
const count = (text, fragment) => text.split(fragment).length - 1;
const ref = (id, name, etn = "simetrix_gantttestitem") => ({ id: { guid: id }, etn, ...(name ? { name } : {}) });
const item = (recordId, name, start, due, extra = {}) => ({ recordId, name, assignedTo: "", status: "Active", start, due, ...extra });
const d = (y, m, day) => new Date(y, m - 1, day);

function renderGantt(props) {
  const originalError = console.error;
  console.error = message => { if (!String(message).includes("useLayoutEffect")) originalError(message); };
  try {
    return renderToStaticMarkup(React.createElement(Gantt, {
      allocatedHeight: 600, allocatedWidth: 1200, loading: false,
      filters: { status: "all", createdOn: "all", dueDate: "all" }, sorting: undefined,
      licenseState: "licensed", licenseMessage: "", onRevalidateLicense: noop, onFiltersChange: noop, onSortChange: noop,
      onRefresh: noop, onOpen: noop, refreshDisabled: false, refreshing: false, instanceId: "test",
      ...props
    }));
  } finally {
    console.error = originalError;
  }
}

// --- Value parsing ---
assert.deepStrictEqual(toParentRef(ref("{AB-CD}", "Phase A"), ""), { id: "ab-cd", entityType: "simetrix_gantttestitem", name: "Phase A" });
assert.deepStrictEqual(toParentRef(ref("ab-cd"), ""), { id: "ab-cd", entityType: "simetrix_gantttestitem" }, "no name when Dataverse returned none");
assert.deepStrictEqual(toParentRef({ id: "ab-cd", entityType: "Task" }, "Shown"), { id: "ab-cd", entityType: "task", name: "Shown" }, "formatted text is used when the reference has no name");
assert.deepStrictEqual(toParentRef([ref("x1", "First")], ""), { id: "x1", entityType: "simetrix_gantttestitem", name: "First" });
assert.strictEqual(toParentRef(null, ""), null);
assert.strictEqual(toParentRef({ name: "no id" }, ""), null);
[true, 1, "1", "true"].forEach(value => assert.strictEqual(toFlag(value), true, `flag ${value}`));
[false, 0, "0", "", null, undefined, "Yes"].forEach(value => assert.strictEqual(toFlag(value), false, `flag ${value}`));
assert.strictEqual(toSequence("12.5"), 12.5);
assert.strictEqual(toSequence(""), null);
assert.strictEqual(toSequence("x"), null);

// --- Mapping: custom tables opt in explicitly ---
const customMap = resolveFieldMap(HIERARCHY_COLUMNS, "simetrix_gantttestitem");
assert.deepStrictEqual(Object.keys(customMap.columns).sort(), ["finish", "milestone", "parent", "sequence", "start", "title"]);
assert.strictEqual(hasHierarchy(customMap), true);
assert.strictEqual(customMap.isProjectTaskTable, undefined);
assert.strictEqual(buildLayout(customMap).notice, undefined);
const flatMap = resolveFieldMap(CUSTOM_COLUMNS, "cr123_plan");
assert.strictEqual(hasHierarchy(flatMap), false);
assert.ok(!("parent" in mapRecord("c", { getValue: () => null, getFormattedValue: () => "" }, flatMap)), "flat rows carry no Phase 2 fields");
// A custom table never guesses hierarchy columns by name.
const unboundNames = resolveFieldMap(PROJECT_TASK_COLUMNS.map(c => ({ ...c, alias: undefined })), "cr123_plan");
assert.deepStrictEqual(Object.keys(unboundNames.columns), []);

// --- Mapping: Project Operations defaults (verified columns only) ---
const poMap = resolveFieldMap(PROJECT_TASK_COLUMNS, "msdyn_projecttask");
assert.strictEqual(poMap.isProjectTaskTable, true);
assert.deepStrictEqual(
  Object.fromEntries(Object.entries(poMap.columns).map(([key, column]) => [key, column.name])),
  { title: "msdyn_subject", start: "msdyn_start", finish: "msdyn_finish", parent: "msdyn_parenttask", milestone: "msdyn_ismilestone", sequence: "msdyn_displaysequence", summary: "msdyn_summary" }
);
assert.deepStrictEqual(poMap.missingViewColumns, []);
const poLayout = buildLayout(poMap);
assert.strictEqual(poLayout.title, "Project Tasks");
assert.strictEqual(poLayout.notice, undefined);
// Unbound Start/Finish fall back to msdyn_start/msdyn_finish, never msdyn_scheduledstart/msdyn_scheduledend.
const poUnbound = resolveFieldMap([
  { name: "msdyn_scheduledstart", dataType: "DateAndTime.DateOnly" },
  { name: "msdyn_scheduledend", dataType: "DateAndTime.DateOnly" },
  ...PROJECT_TASK_COLUMNS.map(c => ({ ...c, alias: undefined }))
], "msdyn_projecttask");
assert.strictEqual(poUnbound.columns.start.name, "msdyn_start");
assert.strictEqual(poUnbound.columns.finish.name, "msdyn_finish");
// Explicit maker bindings win over the defaults.
const poRebound = resolveFieldMap([
  { name: "msdyn_scheduledstart", alias: "scheduledstart", dataType: "DateAndTime.DateOnly" },
  { name: "cr123_altparent", alias: "parent", dataType: "Lookup.Simple" },
  ...PROJECT_TASK_COLUMNS.filter(c => c.alias !== "scheduledstart")
], "msdyn_projecttask");
assert.strictEqual(poRebound.columns.start.name, "msdyn_scheduledstart");
assert.strictEqual(poRebound.columns.parent.name, "cr123_altparent");
// Defaults only apply to columns in the view; missing ones are named in a notice and their features stay off.
const poPartial = resolveFieldMap(PROJECT_TASK_COLUMNS.filter(c => !["msdyn_parenttask", "msdyn_displaysequence"].includes(c.name)), "msdyn_projecttask");
assert.strictEqual(hasHierarchy(poPartial), false);
assert.deepStrictEqual(poPartial.missingViewColumns, ["Parent Task", "Display Sequence"]);
assert.ok(buildLayout(poPartial).notice.includes("Add Parent Task, Display Sequence to the view"));

// --- Hierarchy building ---
const p = item("P", "Phase", d(2026, 3, 2), d(2026, 3, 20), { parent: null, sequence: 1 });
const a = item("A", "Design", d(2026, 3, 2), d(2026, 3, 6), { parent: { id: "p", name: "Phase" }, sequence: 3 });
const b = item("B", "Build", d(2026, 3, 9), d(2026, 3, 20), { parent: { id: "p", name: "Phase" }, sequence: 2 });
const orphanNamed = item("C", "Snagging", d(2026, 4, 1), d(2026, 4, 3), { parent: { id: "zz", name: "Handover" }, sequence: 9 });
const orphanUnnamed = item("D", "Sign-off", d(2026, 4, 6), d(2026, 4, 6), { parent: { id: "yy" }, sequence: 10 });

const tree = buildHierarchy([a, p, b, orphanNamed, orphanUnnamed], { entityType: "simetrix_gantttestitem", useSequence: true });
assert.deepStrictEqual(tree.roots.map(n => n.task.recordId), ["P", "C", "D"], "roots ordered by sequence");
assert.deepStrictEqual(tree.roots[0].children.map(n => n.task.recordId), ["B", "A"], "siblings ordered by sequence");
assert.strictEqual(tree.waitingCount, 2, "rows whose parent is filtered out, on a later page or not readable");
assert.deepStrictEqual(tree.roots.filter(n => n.parentMissing).map(n => n.task.recordId), ["C", "D"]);
// Without a sequence the incoming (user-sorted or server) order is kept.
const unsequenced = buildHierarchy([a, p, b], { entityType: "simetrix_gantttestitem", useSequence: false });
assert.deepStrictEqual(unsequenced.roots[0].children.map(n => n.task.recordId), ["A", "B"]);

// A child whose parent arrives on a later page nests once the parent is loaded.
const before = buildHierarchy([a], { useSequence: true });
assert.deepStrictEqual([before.roots.length, before.waitingCount], [1, 1]);
const after = buildHierarchy([a, p], { useSequence: true });
assert.deepStrictEqual([after.roots.length, after.waitingCount, after.roots[0].children[0].task.recordId], [1, 0, "A"]);

// Self-parent and loops are cut at the first row in display order and shown at the top level.
const self = item("S", "Self", null, null, { parent: { id: "s" } });
const x = item("X", "Loop X", null, null, { parent: { id: "y" } });
const y = item("Y", "Loop Y", null, null, { parent: { id: "x" } });
const loops = buildHierarchy([self, x, y], { useSequence: false });
assert.deepStrictEqual(loops.brokenCycleIds.sort(), ["S", "X"]);
assert.deepStrictEqual(loops.roots.map(n => n.task.recordId), ["S", "X"]);
assert.deepStrictEqual(loops.roots[1].children.map(n => n.task.recordId), ["Y"]);
assert.strictEqual(loops.waitingCount, 0, "loop rows are not counted as waiting for a parent");

// A lookup to another table turns the hierarchy off.
const wrongTable = buildHierarchy([item("W", "W", null, null, { parent: { id: "q", entityType: "account" } })], { entityType: "simetrix_gantttestitem", useSequence: false });
assert.strictEqual(wrongTable.mismatchedTarget, "account");

// --- Summary spans ---
assert.deepStrictEqual(summarySpan(tree.roots[0]), { start: p.start, end: p.due, derived: false, loadedChildCount: 2 }, "stored dates win");
const undated = item("U", "Undated parent", null, null, { parent: null });
const derived = summarySpan(buildHierarchy([undated, { ...a, parent: { id: "u" } }, { ...b, parent: { id: "u" } }], { useSequence: false }).roots[0]);
assert.deepStrictEqual(derived, { start: a.start, end: b.due, derived: true, loadedChildCount: 2 }, "derived from loaded children");
assert.strictEqual(summarySpan(buildHierarchy([undated, item("K", "K", null, null, { parent: { id: "u" } })], { useSequence: false }).roots[0]), null);
// Project Operations summary flag with stored dates renders before any child loads.
const poSummary = item("PS", "Construction", d(2026, 5, 4), d(2026, 6, 26), { parent: null, isSummary: true });
const poOnly = buildHierarchy([poSummary], { entityType: "msdyn_projecttask", useSequence: true });
assert.deepStrictEqual(summarySpan(poOnly.roots[0]), { start: poSummary.start, end: poSummary.due, derived: false, loadedChildCount: 0 });
assert.strictEqual(summarySpan(buildHierarchy([a], { useSequence: false }).roots[0]), null, "a leaf is not a summary");

// --- Visible rows and collapse ---
const visible = visibleRows(tree, new Set());
assert.deepStrictEqual(visible.map(r => [r.task.recordId, r.depth]), [["P", 0], ["B", 1], ["A", 1], ["C", 0], ["D", 0]]);
assert.deepStrictEqual(visibleRows(tree, new Set(["P"])).map(r => r.task.recordId), ["P", "C", "D"]);
assert.strictEqual(visibleRows(tree, new Set(["P"]))[0].expanded, false);

// --- Milestones use the explicit flag only ---
assert.strictEqual(milestoneDate(item("m", "m", d(2026, 3, 1), d(2026, 3, 1))), null, "same start and finish is not a milestone");
assert.strictEqual(milestoneDate(item("m", "m", d(2026, 3, 1), d(2026, 3, 5), { isMilestone: true })).getTime(), d(2026, 3, 5).getTime());
assert.strictEqual(milestoneDate(item("m", "m", d(2026, 3, 1), null, { isMilestone: true })).getTime(), d(2026, 3, 1).getTime());
assert.strictEqual(milestoneDate(item("m", "m", null, null, { isMilestone: true })), null);

// --- Rendering ---
const layout = buildLayout(customMap);
const html = renderGantt({ tasks: [a, p, b, orphanNamed, orphanUnnamed], hierarchy: tree, layout, pageSize: 50, onLoadMore: noop });
assert.strictEqual(count(html, 'class="tg-row'), 5);
assert.ok(html.includes('aria-expanded="true" aria-label="Collapse Phase"'), "chevron on the parent");
assert.strictEqual(count(html, 'class="tg-toggle"'), 1);
assert.strictEqual(count(html, "tg-toggle-spacer"), 4, "leaf rows keep alignment");
assert.ok(html.includes('data-level="2"') && html.includes("calc(clamp(6px, 1vw, 10px) + 16px)"), "children are indented");
assert.ok(html.includes("tg-row-summary"));
assert.strictEqual(count(html, 'class="tg-summary"'), 1, "stored-date summary bar");
assert.ok(!html.includes("tg-summary-derived"));
assert.ok(html.includes(">Handover</span>"), "parent text shown when Dataverse returned it");
assert.ok(html.includes(">Parent not loaded</span>"), "no invented parent text");
assert.ok(html.includes("2 without loaded parent"));
assert.ok(html.includes("Load the next 50 records"));

const derivedHtml = renderGantt({ tasks: [], hierarchy: buildHierarchy([undated, { ...a, parent: { id: "u" } }, { ...b, parent: { id: "u" } }], { useSequence: false }), layout });
assert.strictEqual(count(derivedHtml, 'class="tg-summary tg-summary-derived"'), 1);
assert.ok(derivedHtml.includes("(from 2 loaded child rows; may be incomplete)"), "derived spans are marked as possibly incomplete");
assert.ok(!derivedHtml.includes("tg-row-unscheduled"), "a derived summary row is not reported as unscheduled");

const milestones = [
  item("m1", "Go live", d(2026, 3, 1), d(2026, 3, 5), { isMilestone: true }),
  item("m2", "No date milestone", null, null, { isMilestone: true }),
  item("m3", "Plain", d(2026, 3, 2), d(2026, 3, 2), { isMilestone: false })
];
const milestoneHtml = renderGantt({ tasks: milestones, layout: buildLayout(resolveFieldMap(HIERARCHY_COLUMNS.filter(c => c.alias !== "parent"), "simetrix_gantttestitem")) });
assert.strictEqual(count(milestoneHtml, 'class="tg-milestone '), 1, "diamond only for a dated, flagged row");
assert.ok(milestoneHtml.includes("Go live: milestone on"));
assert.strictEqual(count(milestoneHtml, 'class="tg-bar '), 1, "the unflagged one-day row keeps its bar");
assert.strictEqual(count(milestoneHtml, 'class="tg-unscheduled"'), 1, "a flagged row without dates is Unscheduled");
assert.ok(!milestoneHtml.includes("tg-toggle"), "no hierarchy UI without a Parent mapping");

const poHtml = renderGantt({ tasks: [poSummary], hierarchy: poOnly, layout: poLayout });
assert.strictEqual(count(poHtml, 'class="tg-summary"'), 1, "Project Operations summary bar renders before children load");
assert.ok(!poHtml.includes('class="tg-toggle"'), "no chevron until children are loaded");
assert.ok(renderGantt({ tasks: [], layout: buildLayout(poPartial) }).includes('class="tg-notice" role="status"'));

// --- Control: page size, Project Operations defaults and nesting after Load more ---
{
  const rows = [
    { id: "c1", values: { simetrix_name: "Child", simetrix_startdate: "2026-03-02", simetrix_finishdate: "2026-03-06", simetrix_parentitem: ref("p1"), simetrix_sequence: 2 } },
    { id: "p1", values: { simetrix_name: "Parent", simetrix_parentitem: null, simetrix_sequence: 1 } }
  ];
  const { ds, calls } = makeDataset({ entityType: "simetrix_gantttestitem", columns: HIERARCHY_COLUMNS, rows, hasNextPage: true });
  ds.sortedRecordIds = ["c1"];
  const control = new TaskGantt();
  control.init(makeContext(ds), noop);
  let props = control.updateView(makeContext(ds)).props;
  assert.deepStrictEqual(calls.setPageSize, [50], "hierarchy uses page size 50");
  assert.strictEqual(props.pageSize, 50);
  assert.strictEqual(props.hierarchy.waitingCount, 1, "child stays visible at the top level");
  assert.strictEqual(props.hierarchy.roots[0].task.parent.name, undefined, "no parent text when none was returned");

  ds.sortedRecordIds = ["c1", "p1"];
  props = control.updateView(makeContext(ds)).props;
  assert.strictEqual(props.hierarchy.waitingCount, 0);
  assert.deepStrictEqual(props.hierarchy.roots.map(n => n.task.recordId), ["p1"]);
  assert.deepStrictEqual(props.hierarchy.roots[0].children.map(n => n.task.recordId), ["c1"], "nested once the parent loads");
  assert.deepStrictEqual(calls.setPageSize, [50], "page size set once");

  // A user sort replaces the sequence order but keeps the tree.
  props.onSortChange({ key: "task", direction: "desc" });
  props = control.updateView(makeContext(ds)).props;
  assert.deepStrictEqual(props.hierarchy.roots[0].children.map(n => n.task.recordId), ["c1"]);
}
{
  const { ds, calls } = makeDataset({ entityType: "cr123_plan", columns: CUSTOM_COLUMNS, rows: [] });
  const control = new TaskGantt();
  control.init(makeContext(ds), noop);
  const props = control.updateView(makeContext(ds)).props;
  assert.deepStrictEqual(calls.setPageSize, [10], "flat views keep page size 10");
  assert.strictEqual(props.hierarchy, undefined);
  assert.strictEqual(props.pageSize, 10);
}
{
  const rows = [
    { id: "s1", values: { msdyn_subject: "Construction", msdyn_start: new Date("2026-05-04T08:00:00Z"), msdyn_finish: new Date("2026-06-26T17:00:00Z"), msdyn_parenttask: null, msdyn_summary: true, msdyn_ismilestone: false, msdyn_displaysequence: 16 } },
    { id: "t9", values: { msdyn_subject: "Plumbing", msdyn_start: new Date("2026-05-11T08:00:00Z"), msdyn_finish: new Date("2026-05-15T17:00:00Z"), msdyn_parenttask: ref("s0", "Planning", "msdyn_projecttask"), msdyn_summary: false, msdyn_ismilestone: false, msdyn_displaysequence: 21 } }
  ];
  const { ds } = makeDataset({ entityType: "msdyn_projecttask", columns: PROJECT_TASK_COLUMNS, rows });
  const control = new TaskGantt();
  control.init(makeContext(ds), noop);
  const props = control.updateView(makeContext(ds)).props;
  assert.strictEqual(props.layout.title, "Project Tasks");
  assert.strictEqual(props.tasks[0].isSummary, true);
  // Date and Time values are shown on their calendar day in the user zone (the browser zone when the host gives none).
  const startInstant = new Date("2026-05-04T08:00:00Z");
  assert.strictEqual(props.tasks[0].start.getTime(), new Date(startInstant.getFullYear(), startInstant.getMonth(), startInstant.getDate()).getTime(), "msdyn_start is the Start default");
  assert.deepStrictEqual(props.hierarchy.roots.map(n => n.task.recordId), ["s1", "t9"]);
  assert.strictEqual(props.hierarchy.roots[1].parentMissing, true);
  assert.strictEqual(props.hierarchy.roots[1].task.parent.name, "Planning");
  assert.deepStrictEqual(summarySpan(props.hierarchy.roots[0]).derived, false);
}
{
  // Parent bound to a lookup on another table: notice, flat rows.
  const rows = [{ id: "w1", values: { simetrix_name: "W", simetrix_parentitem: ref("a1", "Contoso", "account") } }];
  const { ds } = makeDataset({ entityType: "simetrix_gantttestitem", columns: HIERARCHY_COLUMNS, rows });
  const control = new TaskGantt();
  control.init(makeContext(ds), noop);
  const props = control.updateView(makeContext(ds)).props;
  assert.strictEqual(props.hierarchy, undefined);
  assert.ok(props.layout.notice.includes("points to the account table"));
}
{
  // Loops log one warning per distinct set, not on every render.
  const rows = [
    { id: "x", values: { simetrix_name: "X", simetrix_parentitem: ref("y") } },
    { id: "y", values: { simetrix_name: "Y", simetrix_parentitem: ref("x") } }
  ];
  const { ds } = makeDataset({ entityType: "simetrix_gantttestitem", columns: HIERARCHY_COLUMNS, rows });
  const control = new TaskGantt();
  control.init(makeContext(ds), noop);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(message);
  try {
    control.updateView(makeContext(ds));
    control.updateView(makeContext(ds));
  } finally {
    console.warn = originalWarn;
  }
  assert.strictEqual(warnings.length, 1);
}

console.log("TaskGantt hierarchy tests passed.");
