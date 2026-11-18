const assert = require("assert");
const { loadSource } = require("./helpers/loadTs");
const { TASK_COLUMNS, CUSTOM_COLUMNS } = require("./helpers/mockDataset");

const { resolveFieldMap, mapRecord, buildLayout, toCalendarDate, parseRawValues, statusOf, TASK_LAYOUT } = loadSource("src/fieldMap.ts");

const record = (values, formatted = {}) => ({
  getValue: name => values[name] === undefined ? null : values[name],
  getFormattedValue: name => formatted[name] !== undefined ? formatted[name] : values[name] == null ? "" : String(values[name])
});
// Date and Time values are placed on their calendar day (browser zone here; the control passes the user's zone).
const dayOf = value => { const d = new Date(value); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const ymd = date => date && [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];

// --- Table detection comes from the bound dataset ---
assert.strictEqual(resolveFieldMap(TASK_COLUMNS, "task").isTaskTable, true);
assert.strictEqual(resolveFieldMap(TASK_COLUMNS, "Task").isTaskTable, true);
assert.strictEqual(resolveFieldMap(CUSTOM_COLUMNS, "cr123_plan").isTaskTable, false);
assert.strictEqual(resolveFieldMap(CUSTOM_COLUMNS, undefined).isTaskTable, false);

// --- Standard Tasks: bound property-sets resolve, raw statecode meaning is known ---
const taskMap = resolveFieldMap(TASK_COLUMNS, "task");
assert.deepStrictEqual(Object.keys(taskMap.columns).sort(), ["createdOn", "finish", "owner", "start", "status", "title"]);
assert.deepStrictEqual({ ...taskMap.completion, column: taskMap.completion.column.name }, { kind: "status", source: "task", column: "statecode", completed: ["1"], canceled: ["2"], open: ["0"] });
assert.strictEqual(taskMap.columns.description, undefined, "Description is not shown for Tasks unless bound");

// Unbound property-sets on Tasks fall back to the table's default column names.
const unboundTaskColumns = TASK_COLUMNS.map(column => ({ ...column, alias: undefined }));
const unboundTaskMap = resolveFieldMap(unboundTaskColumns, "task");
assert.strictEqual(unboundTaskMap.columns.start.name, "scheduledstart");
assert.strictEqual(unboundTaskMap.columns.owner.name, "ownerid");
// ...but a custom table never guesses by name.
const customWithStandardNames = resolveFieldMap(unboundTaskColumns, "cr123_plan");
assert.deepStrictEqual(Object.keys(customWithStandardNames.columns), []);

// Explicit bindings win over table defaults.
const rebound = resolveFieldMap([
  { name: "scheduledstart", dataType: "DateAndTime.DateAndTime" },
  { name: "actualstart", alias: "scheduledstart", dataType: "DateAndTime.DateAndTime" },
  { name: "description", alias: "description", dataType: "Multiple" },
  ...TASK_COLUMNS.filter(column => column.alias !== "scheduledstart")
], "task");
assert.strictEqual(rebound.columns.start.name, "actualstart");
assert.strictEqual(rebound.columns.description.name, "description");

// Status bound to something other than statecode on Tasks: meaning unknown, no raw value assumed.
const statusReason = resolveFieldMap(TASK_COLUMNS.map(c => c.alias === "statecode" ? { ...c, name: "statuscode" } : c), "task");
assert.strictEqual(statusReason.completion, undefined);

// --- Standard Tasks record mapping preserves 3.2.1 behaviour ---
const taskRow = (values, formatted) => mapRecord("t", record(values, formatted), taskMap);

const scheduled = taskRow({
  subject: "Survey site",
  ownerid: "ref",
  statecode: 0,
  scheduledstart: new Date("2026-05-05T08:30:00Z"),
  scheduledend: new Date("2026-05-09T17:00:00Z"),
  createdon: new Date("2026-04-01T10:00:00Z")
}, { ownerid: "A. Reed", statecode: "Open" });
assert.strictEqual(scheduled.name, "Survey site");
assert.strictEqual(scheduled.assignedTo, "A. Reed");
assert.strictEqual(scheduled.status, "Active");
assert.strictEqual(scheduled.start.getTime(), dayOf("2026-05-05T08:30:00Z"), "3.7.0: Date and Time values are placed on their calendar day");
assert.strictEqual(scheduled.due.getTime(), dayOf("2026-05-09T17:00:00Z"));

const createdOnFallback = taskRow({ subject: "x", createdon: new Date("2026-04-01T10:00:00Z"), scheduledend: new Date("2026-04-03T10:00:00Z") });
assert.strictEqual(createdOnFallback.start.getTime(), dayOf("2026-04-01T10:00:00Z"), "Tasks keep the Created On start fallback");

assert.strictEqual(taskRow({ subject: "x", statecode: 1 }, { statecode: "Abgeschlossen" }).status, "Completed", "raw statecode 1 is Completed in any UI language");
assert.strictEqual(taskRow({ subject: "x", statecode: "1" }, { statecode: "Completed" }).status, "Completed");
assert.strictEqual(taskRow({ subject: "x", statecode: 2 }, { statecode: "Canceled" }).status, "Canceled", "3.6.0: Canceled is its own known state, never overdue");
assert.strictEqual(taskRow({ subject: "x", statecode: 0 }, { statecode: "Completed" }).status, "Active", "a Completed label never overrides the raw value");
assert.strictEqual(taskRow({ subject: "x", statecode: 7 }, { statecode: "Completed" }).status, "Neutral", "unknown raw values are neutral, whatever the label");
assert.strictEqual(taskRow({ subject: "x", statecode: 7 }, { statecode: "Completed" }).statusLabel, "Completed", "the mapped status is still displayed");
assert.strictEqual(taskRow({ subject: "x", statecode: 1 }, { statecode: "Abgeschlossen" }).statusLabel, "Abgeschlossen", "3.7.0: the status text is always the localized Dataverse label");
assert.strictEqual(taskRow({ subject: "" }).name, "(Unnamed task)");
assert.strictEqual(taskRow({ subject: "x" }).assignedTo, "Unassigned");

const missingDue = taskRow({ subject: "x", scheduledstart: new Date("2026-05-05T08:00:00Z") });
assert.strictEqual(missingDue.due, null, "missing due date is null, never 1 Jan 1970");
const missingAll = mapRecord("t", record({ subject: "x" }), resolveFieldMap(TASK_COLUMNS.filter(c => c.alias !== "createdon"), "task"));
assert.strictEqual(missingAll.start, null);
assert.strictEqual(missingAll.due, null);

// Legacy 3.2.1 mapping (index.ts:104-121 before Phase 1) agrees for every fully dated, English-labelled task.
function legacyMap(values, formatted) {
  const r = record(values, formatted);
  const formattedState = r.getFormattedValue("statecode") || "Active";
  return {
    name: r.getFormattedValue("subject") || "(Unnamed task)",
    assignedTo: r.getFormattedValue("ownerid") || "Unassigned",
    status: formattedState.toLowerCase() === "completed" ? "Completed" : "Active",
    start: new Date(r.getValue("scheduledstart") || r.getValue("createdon")),
    due: new Date(r.getValue("scheduledend"))
  };
}
[
  [{ subject: "a", ownerid: "r", statecode: 0, scheduledstart: new Date("2026-01-01T09:00:00Z"), scheduledend: new Date("2026-01-04T09:00:00Z"), createdon: new Date("2025-12-01T00:00:00Z") }, { ownerid: "J. Miller", statecode: "Open" }],
  [{ subject: "b", ownerid: "r", statecode: 1, scheduledend: new Date("2026-02-04T09:00:00Z"), createdon: new Date("2026-02-01T00:00:00Z") }, { ownerid: "K. Morgan", statecode: "Completed" }],
  [{ subject: "", statecode: 2, scheduledstart: "2026-03-01T00:00:00Z", scheduledend: "2026-03-02T00:00:00Z", createdon: "2026-01-01T00:00:00Z" }, { statecode: "Canceled" }]
].forEach(([values, formatted]) => {
  const legacy = legacyMap(values, formatted);
  const current = taskRow(values, formatted);
  assert.strictEqual(current.name, legacy.name);
  assert.strictEqual(current.assignedTo, legacy.assignedTo);
  // 3.6.0 departs from 3.2.1 only for Canceled, which 3.2.1 showed as Active.
  assert.strictEqual(current.status, values.statecode === 2 ? "Canceled" : legacy.status);
  assert.strictEqual(current.start.getTime(), dayOf(legacy.start), "same calendar day as 3.2.1");
  assert.strictEqual(current.due.getTime(), dayOf(legacy.due));
});

assert.deepStrictEqual(buildLayout(taskMap), { ...TASK_LAYOUT, showDeadlines: true, showCanceled: true }, "Tasks layout is unchanged from 3.2.1, plus the colour legend");

// --- Minimal organization-owned custom table: Title, Start, Finish only ---
const customMap = resolveFieldMap(CUSTOM_COLUMNS, "cr123_plan");
assert.deepStrictEqual(Object.keys(customMap.columns).sort(), ["finish", "start", "title"]);
assert.strictEqual(customMap.completion, undefined);
const customLayout = buildLayout(customMap);
assert.strictEqual(customLayout.showOwner, false);
assert.strictEqual(customLayout.showStatus, false);
assert.strictEqual(customLayout.showStatusFilter, false);
assert.strictEqual(customLayout.showCreatedOnFilter, false);
assert.strictEqual(customLayout.showDescription, false);
assert.strictEqual(customLayout.labels.task, "Name");
assert.strictEqual(customLayout.labels.start, "Planned Start");
assert.strictEqual(customLayout.labels.due, "Planned Finish");

const customRow = values => mapRecord("c", record(values), customMap);
const plain = customRow({ cr123_name: "Install foundations", cr123_plannedstart: "2025-05-19", cr123_plannedfinish: "2025-05-30", createdon: new Date("2025-01-01T00:00:00Z") });
assert.strictEqual(plain.name, "Install foundations");
assert.strictEqual(plain.assignedTo, "");
assert.deepStrictEqual(ymd(plain.start), [2025, 5, 19, 0, 0]);
assert.deepStrictEqual(ymd(plain.due), [2025, 5, 30, 0, 0]);
assert.strictEqual(customRow({ cr123_name: "x", createdon: new Date() }).start, null, "custom tables never fall back to Created On");
assert.strictEqual(customRow({}).name, "(No title)");

// Optional columns appear once mapped. Status meaning on a custom table is not assumed.
const customFull = resolveFieldMap([
  ...CUSTOM_COLUMNS,
  { name: "ownerid", alias: "ownerid", dataType: "Lookup.Owner", displayName: "Owner" },
  { name: "statecode", alias: "statecode", dataType: "OptionSet", displayName: "Status" },
  { name: "createdon", alias: "createdon", dataType: "DateAndTime.DateAndTime", displayName: "Created On" },
  { name: "cr123_notes", alias: "description", dataType: "Multiple", displayName: "Notes" }
], "cr123_plan");
assert.strictEqual(customFull.completion, undefined);
const customFullLayout = buildLayout(customFull);
assert.strictEqual(customFullLayout.showOwner, true);
assert.strictEqual(customFullLayout.showStatus, true);
assert.strictEqual(customFullLayout.showStatusFilter, false, "no completion filter until completion is configured");
assert.strictEqual(customFullLayout.showDeadlines, false, "no deadline colours without completion semantics");
assert.strictEqual(buildLayout({ ...taskMap, columns: { ...taskMap.columns } }).showStatusFilter, true, "Tasks keep the status filter");
assert.strictEqual(buildLayout(statusReason).showStatusFilter, false, "3.6.0: no completion filter without known raw values (previously learned from labels)");
const reasonRow = mapRecord("t", record({ subject: "x", statuscode: 5 }, { statuscode: "Completed" }), statusReason);
assert.deepStrictEqual([reasonRow.status, reasonRow.statusLabel], ["Neutral", "Completed"], "Status Reason on Tasks: displayed, neutral, not interpreted");
assert.strictEqual(customFullLayout.showCreatedOnFilter, true);
assert.strictEqual(customFullLayout.showDescription, true);
assert.strictEqual(customFullLayout.labels.description, "Notes");
const inactive = mapRecord("c", record({ cr123_name: "x", statecode: 1, cr123_notes: "Pour slab" }, { statecode: "Inactive" }), customFull);
assert.strictEqual(inactive.status, "Neutral", "custom status mappings are neutral");
const doneLabel = mapRecord("c", record({ cr123_name: "x", statecode: 1 }, { statecode: "Completed" }), customFull);
assert.deepStrictEqual([doneLabel.status, doneLabel.statusLabel], ["Neutral", "Completed"], "a Completed label on a custom table is displayed, not interpreted");
assert.strictEqual(inactive.statusLabel, "Inactive");
assert.strictEqual(inactive.description, "Pour slab");

// --- 3.7.0: completion is configured with raw values only ---
assert.deepStrictEqual(parseRawValues(" 5, 192350001;7 "), ["5", "192350001", "7"]);
assert.deepStrictEqual(parseRawValues("05,5"), ["5"], "values are normalized and deduplicated");
assert.deepStrictEqual(parseRawValues(""), []);
assert.strictEqual(parseRawValues("Completed"), undefined, "labels are rejected, never matched");
assert.strictEqual(parseRawValues("1.5"), undefined);
const configured = resolveFieldMap([...CUSTOM_COLUMNS, { name: "statecode", alias: "statecode", dataType: "OptionSet", displayName: "Status" }], "cr123_plan", { completedValues: "1", canceledValues: "" });
assert.deepStrictEqual([configured.completion.kind, configured.completion.source, configured.completion.completed, configured.completion.canceled], ["status", "configured", ["1"], []]);
const configuredRow = (raw, label) => mapRecord("c", record({ cr123_name: "x", statecode: raw }, { statecode: label }), configured);
assert.deepStrictEqual([configuredRow(1, "Inactive").status, configuredRow(1, "Inactive").statusLabel], ["Completed", "Inactive"], "the raw value decides, the label is shown");
assert.strictEqual(configuredRow(0, "Completed").status, "Active", "a Completed label never makes a row Completed");
assert.strictEqual(configuredRow(null, "").status, "Neutral");
assert.strictEqual(buildLayout(configured).showStatusFilter, true);
assert.strictEqual(buildLayout(configured).showCanceled, false, "no Canceled legend without canceled values");
// Configured values replace the built-in Task statecode values.
const taskOverride = resolveFieldMap(TASK_COLUMNS.map(c => c.alias === "statecode" ? { ...c, name: "statuscode" } : c), "task", { completedValues: "5", canceledValues: "6" });
assert.deepStrictEqual([taskOverride.completion.completed, taskOverride.completion.canceled], [["5"], ["6"]]);
assert.strictEqual(statusOf("3", taskOverride.completion), "Active", "every other Status Reason value is open");
assert.strictEqual(statusOf(7, taskMap.completion), "Neutral", "built-in Task statecode: values other than 0, 1, 2 stay neutral");
assert.strictEqual(statusOf(true, taskOverride.completion), "Neutral", "non-numeric raw values are never interpreted");
// Progress column: Completed at the configured value (default 100).
const progressColumns = [...CUSTOM_COLUMNS, { name: "cr123_pct", dataType: "Whole.None", displayName: "Percent" }, { name: "cr123_label", dataType: "SingleLine.Text" }];
const progress = resolveFieldMap(progressColumns, "cr123_plan", { progressColumn: "CR123_PCT" });
assert.deepStrictEqual([progress.completion.kind, progress.completion.column.name, progress.completion.completeAt], ["progress", "cr123_pct", 100]);
assert.deepStrictEqual([99.9, 100, 120, null, "x"].map(value => statusOf(value, progress.completion)), ["Active", "Completed", "Completed", "Neutral", "Neutral"]);
assert.strictEqual(resolveFieldMap(progressColumns, "cr123_plan", { progressColumn: "cr123_pct", progressCompleteValue: 1 }).completion.completeAt, 1, "fraction scales are configurable");
assert.ok(resolveFieldMap(progressColumns, "cr123_plan", { progressColumn: "cr123_label" }).completionError.includes("not a number column"));
assert.ok(resolveFieldMap(CUSTOM_COLUMNS, "cr123_plan", { completedValues: "1" }).completionError.includes("no Status column"));
assert.ok(buildLayout(resolveFieldMap(CUSTOM_COLUMNS, "cr123_plan", { completedValues: "1" })).notice.includes("Deadline colours are off"));
// Project Operations completion is not yet configured or verified: Active alone may not mean unfinished, so nothing is assumed.
const poMap = resolveFieldMap([{ name: "msdyn_subject", dataType: "SingleLine.Text" }, { name: "msdyn_start", dataType: "DateAndTime.DateAndTime" }, { name: "msdyn_finish", dataType: "DateAndTime.DateAndTime" },
  { name: "statecode", alias: "statecode", dataType: "OptionSet" }], "msdyn_projecttask");
assert.strictEqual(poMap.completion, undefined, "Project Operations rows stay neutral until completion is configured and verified");

// --- Date Only values keep their calendar day in every time zone ---
const dateOnlyShapes = [
  "2025-05-05",
  "2025-05-05T00:00:00Z",
  "2025-05-05T00:00:00",
  new Date(Date.UTC(2025, 4, 5)),
  new Date(2025, 4, 5),
  Date.UTC(2025, 4, 5)
];
dateOnlyShapes.forEach(shape => {
  assert.deepStrictEqual(ymd(toCalendarDate(shape, true)), [2025, 5, 5, 0, 0], `Date Only ${String(shape)} in ${process.env.TZ}`);
});
assert.deepStrictEqual(ymd(toCalendarDate("2025-12-31", true)), [2025, 12, 31, 0, 0]);
assert.deepStrictEqual(ymd(toCalendarDate("2024-02-29", true)), [2024, 2, 29, 0, 0]);
[null, undefined, "", "not a date"].forEach(empty => {
  assert.strictEqual(toCalendarDate(empty, true), null);
  assert.strictEqual(toCalendarDate(empty, false), null);
});

console.log("TaskGantt field mapping tests passed.");
