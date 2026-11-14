const assert = require("assert");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadSource } = require("./helpers/loadTs");
const { CUSTOM_COLUMNS } = require("./helpers/mockDataset");

const { Gantt, getScheduleState } = loadSource("src/Gantt.tsx");
const { TASK_LAYOUT, buildLayout, resolveFieldMap } = loadSource("src/fieldMap.ts");

const noop = () => {};
const count = (text, fragment) => text.split(fragment).length - 1;
const fmt = date => date.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });

function renderGantt(props) {
  const originalError = console.error;
  console.error = message => { if (!String(message).includes("useLayoutEffect")) originalError(message); };
  try {
    return renderToStaticMarkup(React.createElement(Gantt, {
      allocatedHeight: 600,
      allocatedWidth: 1200,
      loading: false,
      filters: { status: "all", createdOn: "all", dueDate: "all" },
      sorting: undefined,
      licenseState: "licensed",
      licenseMessage: "",
      onRevalidateLicense: noop,
      onFiltersChange: noop,
      onSortChange: noop,
      onRefresh: noop,
      onOpen: noop,
      refreshDisabled: false,
      refreshing: false,
      instanceId: "test",
      ...props
    }));
  } finally {
    console.error = originalError;
  }
}

const item = (recordId, name, start, due, extra = {}) => ({ recordId, name, assignedTo: "", status: "Active", start, due, ...extra });

// --- Schedule states ---
assert.strictEqual(getScheduleState(item("a", "a", new Date(2025, 4, 5), new Date(2025, 4, 9))), "scheduled");
assert.strictEqual(getScheduleState(item("a", "a", new Date(2025, 4, 5), new Date(2025, 4, 5))), "scheduled");
assert.strictEqual(getScheduleState(item("a", "a", new Date(2025, 4, 9), new Date(2025, 4, 5))), "reversed");
assert.strictEqual(getScheduleState(item("a", "a", null, new Date(2025, 4, 5))), "unscheduled");
assert.strictEqual(getScheduleState(item("a", "a", new Date(2025, 4, 5), null)), "unscheduled");
assert.strictEqual(getScheduleState(item("a", "a", null, null)), "unscheduled");
assert.strictEqual(getScheduleState(item("a", "a", new Date("invalid"), new Date(2025, 4, 5))), "unscheduled");

// --- Minimal custom table ---
const customLayout = buildLayout(resolveFieldMap(CUSTOM_COLUMNS, "cr123_plan"));
const customTasks = [
  item("c1", "Survey", new Date(2025, 4, 5), new Date(2025, 4, 9)),
  item("c2", "Install foundations", new Date(2025, 4, 19), new Date(2025, 4, 30)),
  item("c3", "No dates", null, null),
  item("c4", "Start only", new Date(2025, 5, 2), null),
  item("c5", "Reversed", new Date(2025, 5, 10), new Date(2025, 5, 1))
];

for (const allocatedWidth of [1200, 720]) {
  const html = renderGantt({ tasks: customTasks, layout: customLayout, allocatedWidth });
  const mode = allocatedWidth < 1050 ? "compact" : "detailed";

  customTasks.forEach(t => assert.ok(html.includes(`title="${t.name}"`), `${mode}: ${t.name} has an open button`));
  assert.strictEqual(count(html, 'class="tg-link"'), 5, `${mode}: every record is openable`);
  assert.strictEqual(count(html, 'class="tg-row'), 5, `${mode}: every record renders a row`);
  assert.strictEqual(count(html, 'class="tg-bar '), 2, `${mode}: only fully dated rows draw a bar`);
  assert.strictEqual(count(html, 'class="tg-unscheduled"'), 2, `${mode}: Unscheduled flag in the timeline`);
  assert.strictEqual(count(html, 'tg-unscheduled-note'), 2, `${mode}: Unscheduled flag in the frozen date column`);
  assert.strictEqual(count(html, ">Invalid dates<"), mode === "compact" ? 2 : 1, `${mode}: reversed range flagged separately`);
  assert.ok(html.includes('title="Planned Finish is earlier than Planned Start"'));
  assert.ok(html.includes('title="Missing Planned Start and Planned Finish"'));
  assert.ok(html.includes('title="Missing Planned Finish"'));
  assert.ok(!html.includes("1970"), `${mode}: missing dates never fall back to 1970`);
  const dash = String.fromCharCode(0x2014);
  assert.ok(html.includes(`<span>${dash}</span>`), `${mode}: missing dates render the em dash placeholder`);
  assert.ok(!html.includes("2014<"), `${mode}: placeholder is not a literal 2014`);

  assert.ok(!html.includes("tg-col-assigned"), `${mode}: no owner column`);
  assert.ok(!html.includes("tg-col-status"), `${mode}: no status column`);
  assert.ok(!html.includes("tg-col-description"), `${mode}: no description column`);
  assert.ok(!html.includes("tg-legend"), `${mode}: no status filter`);
  assert.ok(!html.includes("Created On"), `${mode}: no Created On filter`);
  assert.ok(!html.includes("Unassigned"), `${mode}: no placeholder owner text`);
  assert.ok(html.includes("Planned Finish"));
  assert.ok(html.includes(fmt(new Date(2025, 4, 5))), `${mode}: Date Only start shown on its calendar day`);
}

const detailed = renderGantt({ tasks: customTasks, layout: customLayout });
assert.ok(detailed.includes("Name") && detailed.includes("Planned Start"), "custom headers use the mapped column names");
assert.ok(detailed.includes("<strong>Schedule</strong>"));
assert.ok(detailed.includes("Load the next 10 records") === false);

// Timeline range only uses dated rows (5 May 2025 to today), so it stays bounded.
const days = Math.round((Date.now() - new Date(2025, 4, 5).getTime()) / 86400000) + 4;
assert.ok(count(detailed, '<div class="tg-calendar"') === 1);
assert.ok(count(detailed, "<b>") <= days + 2, "timeline is not stretched by unscheduled rows");

// Empty and all-unscheduled states.
assert.ok(renderGantt({ tasks: [], layout: customLayout }).includes("No records found."));
const allUnscheduled = renderGantt({ tasks: [item("u", "Only", null, null)], layout: customLayout });
assert.ok(!allUnscheduled.includes("No records found."), "unscheduled-only data is not reported as empty");
assert.ok(allUnscheduled.includes('title="Only"'));

// Optional columns appear once mapped.
const fullLayout = { ...customLayout, showOwner: true, showStatus: true, showDescription: true, showCreatedOnFilter: true, labels: { ...customLayout.labels, description: "Notes" } };
const full = renderGantt({ tasks: [item("f", "Full", new Date(2025, 4, 5), new Date(2025, 4, 9), { assignedTo: "D. Shah", description: "Pour slab", statusLabel: "Inactive" })], layout: fullLayout });
assert.ok(full.includes("tg-col-assigned") && full.includes("D. Shah"));
assert.ok(full.includes("tg-col-description") && full.includes("Pour slab") && full.includes("Notes"));
assert.ok(full.includes("tg-col-status") && full.includes(">Inactive<"));
assert.ok(full.includes("Created On"));

// --- Standard Tasks keep the 3.2.1 layout ---
const taskHtml = renderGantt({
  tasks: [
    item("t1", "Survey site", new Date(2025, 4, 5), new Date(2025, 4, 9), { assignedTo: "A. Reed" }),
    item("t2", "Final inspection", new Date(2025, 4, 1), null, { assignedTo: "J. Miller" })
  ],
  layout: TASK_LAYOUT,
  onLoadMore: noop
});
["<strong>Tasks Plan</strong>", "Task name", "Assigned to", ">Status<", "Start Date", "Due Date", "Created On", "tg-legend", 'aria-label="Tasks Gantt"', "Load the next 10 tasks", "Refresh tasks"]
  .forEach(fragment => assert.ok(taskHtml.includes(fragment), `Tasks layout keeps ${fragment}`));
assert.ok(!taskHtml.includes("tg-col-description"));
assert.ok(taskHtml.includes('aria-label="Survey site, owner A. Reed"'));
assert.strictEqual(count(taskHtml, 'class="tg-unscheduled"'), 1, "Task without a due date is Unscheduled, not Invalid dates");
assert.ok(!taskHtml.includes(">Invalid dates<"));

// Gantt without a layout prop still renders the Tasks layout.
assert.ok(renderGantt({ tasks: [] }).includes("No tasks found."));

console.log("TaskGantt render tests passed.");
