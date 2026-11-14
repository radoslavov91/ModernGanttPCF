const assert = require("assert");
const { loadSource } = require("./helpers/loadTs");
const { TASK_COLUMNS, CUSTOM_COLUMNS, makeDataset, makeContext, installWindowStub } = require("./helpers/mockDataset");

installWindowStub();
const { TaskGantt } = loadSource("index.ts");
const { TASK_LAYOUT } = loadSource("src/fieldMap.ts");

const allFilters = { status: "all", createdOn: "all", dueDate: "all" };
const render = (control, ds, options) => control.updateView(makeContext(ds, options)).props;

// --- Existing standard Tasks configuration (all six 3.2.1 bindings present) ---
{
  const { ds, calls } = makeDataset({
    entityType: "task",
    columns: TASK_COLUMNS,
    hasNextPage: true,
    rows: [
      { id: "t1", values: { subject: "Survey site", ownerid: "r", statecode: 0, scheduledstart: new Date("2026-05-05T08:00:00Z"), scheduledend: new Date("2026-05-09T17:00:00Z"), createdon: new Date("2026-04-01T00:00:00Z") }, formatted: { ownerid: "A. Reed", statecode: "Open" } },
      { id: "t2", values: { subject: "Approve drawings", ownerid: "r", statecode: 1, scheduledend: new Date("2026-05-16T17:00:00Z"), createdon: new Date("2026-05-12T09:00:00Z") }, formatted: { ownerid: "K. Morgan", statecode: "Abgeschlossen" } },
      { id: "t3", values: { subject: "Final inspection", ownerid: "r", statecode: 0, createdon: new Date("2026-05-01T09:00:00Z") }, formatted: { ownerid: "J. Miller", statecode: "Open" } }
    ]
  });
  const control = new TaskGantt();
  control.init(makeContext(ds), () => {});
  const props = render(control, ds);

  assert.strictEqual(props.licenseState, "unlicensed", "licence gate still applies without a key");
  assert.deepStrictEqual(props.layout, TASK_LAYOUT);
  assert.deepStrictEqual(props.tasks.map(t => t.recordId), ["t1", "t2", "t3"], "all records stay visible");
  assert.strictEqual(props.tasks[1].status, "Completed");
  assert.strictEqual(props.tasks[1].start.getTime(), Date.parse("2026-05-12T09:00:00Z"), "Created On start fallback");
  assert.strictEqual(props.tasks[2].due, null, "missing due date stays null");

  // Navigation works for every row, including unscheduled ones.
  props.onOpen("t3");
  assert.deepStrictEqual(calls.opened, [{ id: { guid: "t3" }, etn: "task", name: "Final inspection" }]);

  // Paging: page size 10 set once; load more is wired.
  render(control, ds);
  assert.deepStrictEqual(calls.setPageSize, [10]);
  props.onLoadMore();
  assert.strictEqual(calls.loadNextPage, 1);

  // Status filters use the known raw statecode value.
  props.onFiltersChange({ ...allFilters, status: "completed" });
  assert.deepStrictEqual(calls.setFilter.pop().conditions, [{ attributeName: "statecode", conditionOperator: 0, value: "1" }]);
  props.onFiltersChange({ ...allFilters, status: "overdue" });
  const overdue = calls.setFilter.pop().conditions;
  assert.deepStrictEqual(overdue[0], { attributeName: "statecode", conditionOperator: 1, value: "1" });
  assert.strictEqual(overdue[1].attributeName, "scheduledend");
  assert.strictEqual(overdue[1].conditionOperator, 3);
  props.onFiltersChange({ ...allFilters, createdOn: "thisWeek", dueDate: "lastMonth" });
  assert.deepStrictEqual(calls.setFilter.pop().conditions, [
    { attributeName: "createdon", conditionOperator: 20, value: "" },
    { attributeName: "scheduledend", conditionOperator: 22, value: "" }
  ]);
  props.onFiltersChange(allFilters);
  assert.strictEqual(calls.clearFilter, 1);
  assert.ok(calls.reset >= 4 && calls.refresh >= 4, "filters reset paging and refresh");

  // Sorting resolves the bound columns.
  props.onSortChange({ key: "assignedTo", direction: "desc" });
  assert.deepStrictEqual(ds.sorting, [{ name: "ownerid", sortDirection: 1 }]);
}

// --- Minimal organization-owned custom table: only Title, Start, Finish bound ---
{
  const { ds, calls } = makeDataset({
    entityType: "cr123_plan",
    columns: CUSTOM_COLUMNS,
    rows: [
      { id: "c1", values: { cr123_name: "Install foundations", cr123_plannedstart: "2025-05-19", cr123_plannedfinish: "2025-05-30" } },
      { id: "c2", values: { cr123_name: "Survey", cr123_plannedstart: new Date(Date.UTC(2025, 4, 5)), cr123_plannedfinish: new Date(Date.UTC(2025, 4, 9)) } },
      { id: "c3", values: { cr123_name: "No dates" } },
      { id: "c4", values: { cr123_name: "Start only", cr123_plannedstart: "2025-06-02" } },
      { id: "c5", values: { cr123_name: "Reversed", cr123_plannedstart: "2025-06-10", cr123_plannedfinish: "2025-06-01" } }
    ]
  });
  const control = new TaskGantt();
  control.init(makeContext(ds), () => {});
  const props = render(control, ds);

  assert.deepStrictEqual(props.tasks.map(t => t.recordId), ["c1", "c2", "c3", "c4", "c5"]);
  assert.strictEqual(props.layout.showOwner, false);
  assert.strictEqual(props.layout.showStatus, false);
  assert.strictEqual(props.layout.showStatusFilter, false);
  assert.strictEqual(props.layout.showCreatedOnFilter, false);
  assert.strictEqual(props.layout.labels.due, "Planned Finish");
  assert.strictEqual(props.tasks[1].start.getDate(), 5, `Date Only start day in ${process.env.TZ}`);
  assert.strictEqual(props.tasks[1].due.getDate(), 9, `Date Only finish day in ${process.env.TZ}`);
  assert.strictEqual(props.tasks[2].start, null);
  assert.strictEqual(props.tasks[3].due, null);
  assert.strictEqual(props.onLoadMore, undefined);

  props.onOpen("c3");
  assert.deepStrictEqual(calls.opened, [{ id: { guid: "c3" }, etn: "cr123_plan", name: "No dates" }]);

  // Unmapped status/created-on filters add no conditions; Finish filters use the mapped column.
  props.onFiltersChange({ ...allFilters, status: "completed", createdOn: "thisWeek" });
  assert.strictEqual(calls.setFilter.length, 0);
  assert.strictEqual(calls.clearFilter, 1);
  props.onFiltersChange({ ...allFilters, dueDate: "thisMonth" });
  assert.deepStrictEqual(calls.setFilter.pop().conditions, [{ attributeName: "cr123_plannedfinish", conditionOperator: 23, value: "" }]);

  props.onSortChange({ key: "startDate", direction: "asc" });
  assert.deepStrictEqual(ds.sorting, [{ name: "cr123_plannedstart", sortDirection: 0 }]);
  const sortCountBefore = calls.refresh;
  props.onSortChange({ key: "assignedTo", direction: "asc" });
  assert.strictEqual(calls.refresh, sortCountBefore, "sorting by an unmapped owner is skipped");
}

// --- Custom table with Status mapped: status stays visible, completion filter is deferred ---
{
  const { ds, calls } = makeDataset({
    entityType: "cr123_plan",
    columns: [...CUSTOM_COLUMNS, { name: "statecode", alias: "statecode", dataType: "OptionSet", displayName: "Status" }],
    rows: [
      { id: "s1", values: { cr123_name: "Done", statecode: 1, cr123_plannedstart: "2025-05-01", cr123_plannedfinish: "2025-05-02" }, formatted: { statecode: "Completed" } },
      { id: "s2", values: { cr123_name: "Open", statecode: 0, cr123_plannedstart: "2025-05-03", cr123_plannedfinish: "2025-05-04" }, formatted: { statecode: "Active" } }
    ]
  });
  const control = new TaskGantt();
  control.init(makeContext(ds), () => {});
  render(control, ds);
  const props = render(control, ds);

  assert.strictEqual(props.layout.showStatus, true, "mapped status column stays visible");
  assert.strictEqual(props.layout.showStatusFilter, false, "no completion filter even after a Completed label was seen");
  assert.deepStrictEqual(props.tasks.map(t => t.statusLabel), ["Completed", "Active"]);
  assert.strictEqual(control.completedRawValue, undefined, "labels are not observed on custom tables");

  props.onFiltersChange({ ...allFilters, status: "completed" });
  props.onFiltersChange({ ...allFilters, status: "overdue" });
  assert.strictEqual(calls.setFilter.length, 0, "no status condition is built from labels");
}

console.log("TaskGantt control tests passed.");
