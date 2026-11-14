const assert = require("assert");
const { loadSource } = require("./helpers/loadTs");
const { TASK_COLUMNS, CUSTOM_COLUMNS } = require("./helpers/mockDataset");

const { resolveFieldMap, mapRecord, buildLayout, toCalendarDate, TASK_LAYOUT } = loadSource("src/fieldMap.ts");

const record = (values, formatted = {}) => ({
  getValue: name => values[name] === undefined ? null : values[name],
  getFormattedValue: name => formatted[name] !== undefined ? formatted[name] : values[name] == null ? "" : String(values[name])
});
const ymd = date => date && [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];

// --- Table detection comes from the bound dataset ---
assert.strictEqual(resolveFieldMap(TASK_COLUMNS, "task").isTaskTable, true);
assert.strictEqual(resolveFieldMap(TASK_COLUMNS, "Task").isTaskTable, true);
assert.strictEqual(resolveFieldMap(CUSTOM_COLUMNS, "cr123_plan").isTaskTable, false);
assert.strictEqual(resolveFieldMap(CUSTOM_COLUMNS, undefined).isTaskTable, false);

// --- Standard Tasks: bound property-sets resolve, raw statecode meaning is known ---
const taskMap = resolveFieldMap(TASK_COLUMNS, "task");
assert.deepStrictEqual(Object.keys(taskMap.columns).sort(), ["createdOn", "finish", "owner", "start", "status", "title"]);
assert.strictEqual(taskMap.completedRawValue, "1");
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
assert.strictEqual(statusReason.completedRawValue, undefined);

// --- Standard Tasks record mapping preserves 3.2.1 behaviour ---
const taskRow = (values, formatted) => mapRecord("t", record(values, formatted), taskMap, taskMap.completedRawValue);

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
assert.strictEqual(scheduled.start.getTime(), Date.parse("2026-05-05T08:30:00Z"), "Date and Time values keep their instant");
assert.strictEqual(scheduled.due.getTime(), Date.parse("2026-05-09T17:00:00Z"));

const createdOnFallback = taskRow({ subject: "x", createdon: new Date("2026-04-01T10:00:00Z"), scheduledend: new Date("2026-04-03T10:00:00Z") });
assert.strictEqual(createdOnFallback.start.getTime(), Date.parse("2026-04-01T10:00:00Z"), "Tasks keep the Created On start fallback");

assert.strictEqual(taskRow({ subject: "x", statecode: 1 }, { statecode: "Abgeschlossen" }).status, "Completed", "raw statecode 1 is Completed in any UI language");
assert.strictEqual(taskRow({ subject: "x", statecode: "1" }, { statecode: "Completed" }).status, "Completed");
assert.strictEqual(taskRow({ subject: "x", statecode: 2 }, { statecode: "Canceled" }).status, "Active", "Canceled still shows as Active, as in 3.2.1");
assert.strictEqual(taskRow({ subject: "x", statecode: 1 }).statusLabel, "Completed");
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
  assert.strictEqual(current.status, legacy.status);
  assert.strictEqual(current.start.getTime(), legacy.start.getTime());
  assert.strictEqual(current.due.getTime(), legacy.due.getTime());
});

assert.deepStrictEqual(buildLayout(taskMap), TASK_LAYOUT, "Tasks layout is unchanged from 3.2.1");

// --- Minimal organization-owned custom table: Title, Start, Finish only ---
const customMap = resolveFieldMap(CUSTOM_COLUMNS, "cr123_plan");
assert.deepStrictEqual(Object.keys(customMap.columns).sort(), ["finish", "start", "title"]);
assert.strictEqual(customMap.completedRawValue, undefined);
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
assert.strictEqual(customFull.completedRawValue, undefined);
const customFullLayout = buildLayout(customFull);
assert.strictEqual(customFullLayout.showOwner, true);
assert.strictEqual(customFullLayout.showStatus, true);
assert.strictEqual(customFullLayout.showStatusFilter, false, "custom-table completion filter is deferred until configurable");
assert.strictEqual(buildLayout({ ...taskMap, columns: { ...taskMap.columns } }).showStatusFilter, true, "Tasks keep the status filter");
assert.strictEqual(buildLayout(statusReason).showStatusFilter, true, "Tasks keep the filter when status is bound to another column");
assert.strictEqual(customFullLayout.showCreatedOnFilter, true);
assert.strictEqual(customFullLayout.showDescription, true);
assert.strictEqual(customFullLayout.labels.description, "Notes");
const inactive = mapRecord("c", record({ cr123_name: "x", statecode: 1, cr123_notes: "Pour slab" }, { statecode: "Inactive" }), customFull);
assert.strictEqual(inactive.status, "Active", "Inactive is not treated as Completed");
assert.strictEqual(inactive.statusLabel, "Inactive");
assert.strictEqual(inactive.description, "Pour slab");

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
