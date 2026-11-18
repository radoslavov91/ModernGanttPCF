const assert = require("assert");
const { loadSource } = require("./helpers/loadTs");
const { TASK_COLUMNS, CUSTOM_COLUMNS, makeDataset, makeContext, installWindowStub } = require("./helpers/mockDataset");

installWindowStub();
const { TaskGantt } = loadSource("index.ts");
const { TASK_LAYOUT } = loadSource("src/fieldMap.ts");

(async () => {
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
  assert.deepStrictEqual(props.layout, { ...TASK_LAYOUT, showDeadlines: true, showCanceled: true }, "Tasks keep their layout and gain the deadline legend");
  assert.deepStrictEqual(props.tasks.map(t => t.statusLabel), ["Open", "Abgeschlossen", "Open"], "status text is Dataverse's localized label");
  assert.deepStrictEqual(props.tasks.map(t => t.recordId), ["t1", "t2", "t3"], "all records stay visible");
  assert.strictEqual(props.tasks[1].status, "Completed");
  const created = new Date("2026-05-12T09:00:00Z");
  assert.strictEqual(props.tasks[1].start.getTime(), new Date(created.getFullYear(), created.getMonth(), created.getDate()).getTime(), "Created On start fallback, on its calendar day");
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
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.deepStrictEqual(overdue, [
    { attributeName: "statecode", conditionOperator: 0, value: "0" },
    { attributeName: "scheduledend", conditionOperator: 26, value: ymd(yesterday) }
  ], "Overdue is Open (0) with Finish on or before yesterday: due today is not overdue");
  props.onFiltersChange({ ...allFilters, status: "active" });
  assert.deepStrictEqual(calls.setFilter.pop().conditions, [{ attributeName: "statecode", conditionOperator: 0, value: "0" }], "Active is Open (0)");
  props.onFiltersChange({ ...allFilters, createdOn: "thisWeek", dueDate: "lastMonth" });
  assert.deepStrictEqual(calls.setFilter.pop().conditions, [
    { attributeName: "createdon", conditionOperator: 20, value: "" },
    { attributeName: "scheduledend", conditionOperator: 22, value: "" }
  ]);
  props.onFiltersChange(allFilters);
  assert.strictEqual(calls.clearFilter, 1);
  assert.ok(calls.reset >= 5 && calls.refresh >= 5, "filters reset paging and refresh");

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
  assert.deepStrictEqual(props.tasks.map(t => t.status), ["Neutral", "Neutral"], "a Completed label is displayed, never interpreted");

  props.onFiltersChange({ ...allFilters, status: "completed" });
  props.onFiltersChange({ ...allFilters, status: "overdue" });
  assert.strictEqual(calls.setFilter.length, 0, "no status condition is built from labels");
}

// --- Standard Tasks with Status bound to Status Reason: no completion is inferred from labels ---
{
  const { ds, calls } = makeDataset({
    entityType: "task",
    columns: TASK_COLUMNS.map(c => c.alias === "statecode" ? { ...c, name: "statuscode", displayName: "Status Reason" } : c),
    rows: [
      { id: "r1", values: { subject: "Done", statuscode: 5, scheduledstart: new Date("2020-01-01T08:00:00Z"), scheduledend: new Date("2020-01-02T08:00:00Z") }, formatted: { statuscode: "Completed" } },
      { id: "r2", values: { subject: "Open", statuscode: 2, scheduledstart: new Date("2020-01-01T08:00:00Z"), scheduledend: new Date("2020-01-02T08:00:00Z") }, formatted: { statuscode: "Not Started" } }
    ]
  });
  const control = new TaskGantt();
  control.init(makeContext(ds), () => {});
  render(control, ds);
  const props = render(control, ds);
  assert.deepStrictEqual(props.tasks.map(t => [t.status, t.statusLabel]), [["Neutral", "Completed"], ["Neutral", "Not Started"]]);
  assert.strictEqual(props.layout.showStatusFilter, false, "3.5.0 learned Completed from the label here; 3.6.0 does not");
  props.onFiltersChange({ ...allFilters, status: "completed" });
  assert.strictEqual(calls.setFilter.length, 0, "no status condition without known raw values");
}

// --- 3.7.0: explicit completion semantics (raw values only), user time zone and the shared deadline rule ---
const ymdUser = (offset, shiftDays = 0) => { const d = new Date(Date.now() + offset * 60000); d.setUTCDate(d.getUTCDate() + shiftDays); return d.toISOString().slice(0, 10); };
const localDay = ymd => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
// Model-driven host metadata shape, verified in sandbox-simetrix (2026-11-18).
const hostMetadata = optionSets => ({ getEntityMetadata: async (table, [name]) => ({ Attributes: { get: key => key === name && optionSets[name] ? { OptionSet: optionSets[name] } : undefined } }) });
const STATUS_REASON = { 2: { text: "Nicht begonnen", value: 2 }, 3: { text: "In Bearbeitung", value: 3 }, 5: { text: "Abgeschlossen", value: 5 }, 6: { text: "Abgebrochen", value: 6 } };
const fresh = (ds, options) => { const control = new TaskGantt(); control.init(makeContext(ds, options), () => {}); return control; };
{
  const reasonColumns = TASK_COLUMNS.map(c => c.alias === "statecode" ? { ...c, name: "statuscode", displayName: "Status Reason" } : c);
  const dates = { scheduledstart: new Date("2020-01-01T08:00:00Z"), scheduledend: new Date("2020-01-02T08:00:00Z") };
  const { ds, calls } = makeDataset({
    entityType: "task",
    columns: reasonColumns,
    rows: [
      { id: "r1", values: { subject: "Done", statuscode: 5, ...dates }, formatted: { statuscode: "Abgeschlossen" } },
      { id: "r2", values: { subject: "Late", statuscode: 3, ...dates }, formatted: { statuscode: "In Bearbeitung" } },
      { id: "r3", values: { subject: "Dropped", statuscode: 6, ...dates }, formatted: { statuscode: "Abgebrochen" } },
      { id: "r4", values: { subject: "Blank", statuscode: null, ...dates } }
    ]
  });
  const options = { parameters: { completedStatusValues: "5", canceledStatusValues: " 6 " }, offsetMinutes: 120, utils: hostMetadata({ statuscode: STATUS_REASON }) };
  const control = fresh(ds, options);
  let props = render(control, ds, options);
  assert.deepStrictEqual(props.tasks.map(t => [t.status, t.statusLabel]), [["Completed", "Abgeschlossen"], ["Active", "In Bearbeitung"], ["Canceled", "Abgebrochen"], ["Neutral", ""]],
    "configured raw values decide the state; the localized label is only displayed; an empty value is never interpreted");
  assert.strictEqual(props.layout.showStatusFilter, true);
  assert.strictEqual(props.layout.showCanceled, true);
  assert.strictEqual(props.today.getTime(), localDay(ymdUser(120)).getTime(), "today is the user's Dynamics day");
  props.onFiltersChange({ ...allFilters, status: "overdue" });
  assert.deepStrictEqual(calls.setFilter.pop().conditions, [
    { attributeName: "statuscode", conditionOperator: 1, value: "5" },
    { attributeName: "statuscode", conditionOperator: 1, value: "6" },
    { attributeName: "scheduledend", conditionOperator: 26, value: ymdUser(120, -1) }
  ], "overdue filter uses the configured values and the user's yesterday");
  props.onFiltersChange({ ...allFilters, status: "completed" });
  assert.deepStrictEqual(calls.setFilter.pop().conditions, [{ attributeName: "statuscode", conditionOperator: 0, value: "5" }]);
  await tick();
  props = render(control, ds, options);
  assert.strictEqual(props.layout.notice, undefined, "configured values are options of Status Reason");

  // A value that is not an option is reported once metadata arrives.
  const typo = { ...options, parameters: { completedStatusValues: "5, 50" } };
  const typoControl = fresh(ds, typo);
  render(typoControl, ds, typo);
  await tick();
  assert.ok(render(typoControl, ds, typo).layout.notice.includes("50 is not an option of Status Reason"));

  // Invalid settings switch the colours off with a reason instead of guessing.
  for (const [parameters, reason] of [[{ completedStatusValues: "Completed" }, "whole numbers"], [{ completedStatusValues: "5", canceledStatusValues: "5" }, "both Completed and Canceled"],
    [{ canceledStatusValues: "6" }, "Completed status values as well"], [{ dueSoonDays: 1, dueNearDays: 3 }, "must not increase"], [{ dueSoonDays: -1 }, "whole numbers of days"]]) {
    const bad = { parameters, offsetMinutes: 0 };
    const badProps = render(fresh(ds, bad), ds, bad);
    assert.ok((badProps.layout.notice || "").includes(reason), `${JSON.stringify(parameters)} explains: ${badProps.layout.notice}`);
  }
  const thresholds = { parameters: { dueSoonDays: 7, dueNearDays: 3, dueImminentDays: 1 }, offsetMinutes: 0 };
  assert.deepStrictEqual(render(fresh(ds, thresholds), ds, thresholds).thresholds, { approaching: 7, near: 3, imminent: 1 });
  assert.deepStrictEqual(props.thresholds, { approaching: 2, near: 1, imminent: 0 }, "3.6.0 default kept: colours start 2 days before Finish");
}
{
  // Progress column (for example a percent complete column): Completed at the configured value, never from a label.
  const dates = { cr123_plannedstart: "2025-05-01", cr123_plannedfinish: "2025-05-02" };
  const { ds, calls } = makeDataset({
    entityType: "cr123_plan",
    columns: [...CUSTOM_COLUMNS, { name: "cr123_progress", dataType: "Decimal", displayName: "Progress" }],
    rows: [
      { id: "p1", values: { cr123_name: "Done", cr123_progress: 100, ...dates } },
      { id: "p2", values: { cr123_name: "Half", cr123_progress: 50, ...dates } },
      { id: "p3", values: { cr123_name: "Unknown", cr123_progress: null, ...dates } }
    ]
  });
  const options = { parameters: { progressColumn: "cr123_progress" }, offsetMinutes: -300 };
  const props = render(fresh(ds, options), ds, options);
  assert.deepStrictEqual(props.tasks.map(t => t.status), ["Completed", "Active", "Neutral"]);
  assert.strictEqual(props.layout.showCanceled, false);
  props.onFiltersChange({ ...allFilters, status: "active" });
  assert.deepStrictEqual(calls.setFilter.pop().conditions, [{ attributeName: "cr123_progress", conditionOperator: 3, value: "100" }]);
  props.onFiltersChange({ ...allFilters, status: "completed" });
  assert.deepStrictEqual(calls.setFilter.pop().conditions, [{ attributeName: "cr123_progress", conditionOperator: 4, value: "100" }]);
  const missing = { parameters: { progressColumn: "cr123_percent" } };
  assert.ok(render(fresh(ds, missing), ds, missing).layout.notice.includes("cr123_percent is not in this view"));
}
{
  // User-local Date and Time values are placed on the user's Dynamics day, whatever the browser zone.
  const columns = CUSTOM_COLUMNS.map(c => c.alias === "scheduledend" || c.alias === "scheduledstart" ? { ...c, dataType: "DateAndTime.DateAndTime" } : c);
  const instant = new Date("2026-05-04T20:00:00Z");
  const { ds } = makeDataset({ entityType: "cr123_plan", columns, rows: [{ id: "z", values: { cr123_name: "Z", cr123_plannedstart: instant, cr123_plannedfinish: instant } }] });
  for (const [offset, day] of [[600, 5], [-300, 4], [0, 4], [240, 5]]) {
    const options = { offsetMinutes: offset };
    const task = render(fresh(ds, options), ds, options).tasks[0];
    assert.deepStrictEqual([task.due.getFullYear(), task.due.getMonth() + 1, task.due.getDate(), task.due.getHours()], [2026, 5, day, 0], `UTC${offset / 60}: Finish on 5/${day}`);
  }
  // Time zone independent columns keep their stored day (metadata Behavior 3); no conversion.
  const options = { offsetMinutes: 600, utils: { getEntityMetadata: async (table, [name]) => ({ Attributes: { get: key => key === name ? { Behavior: 3 } : undefined } }) } };
  const control = fresh(ds, options);
  render(control, ds, options);
  await tick();
  assert.strictEqual(render(control, ds, options).tasks[0].due.getDate(), 4, "time zone independent: stored day");
}

console.log("TaskGantt control tests passed.");
})().catch(error => { console.error(error); process.exit(1); });
