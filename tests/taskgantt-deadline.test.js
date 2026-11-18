// 3.7.0: one deadline calculation for colours, the overdue icon, tooltips and the overdue filter. Runs in every zone
// of tests/run.js; the user's Dynamics zone is passed explicitly, so results never depend on the browser zone.
const assert = require("assert");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadSource } = require("./helpers/loadTs");
const { CUSTOM_COLUMNS } = require("./helpers/mockDataset");

const dl = loadSource("src/deadline.ts");
const { Gantt, rowDeadline, barTone } = loadSource("src/Gantt.tsx");
const { buildLayout, resolveFieldMap, TASK_LAYOUT } = loadSource("src/fieldMap.ts");
const { choiceOptionsFromMetadata } = loadSource("src/viewCriteria.ts");

const today = new Date(2026, 10, 18);
const day = offset => new Date(2026, 10, 18 + offset);
const count = (text, fragment) => text.split(fragment).length - 1;

// --- Colour boundaries with the defaults (yellow 2, orange 1, dark orange 0 days before Finish) ---
const level = (offset, status = "Active", thresholds) => dl.deadlineState(status, day(offset), today, thresholds)?.level;
assert.deepStrictEqual([5, 3, 2, 1, 0, -1, -30].map(offset => level(offset)), ["scheduled", "scheduled", "approaching", "near", "imminent", "overdue", "overdue"]);
assert.strictEqual(level(0), "imminent", "due today is dark orange, never overdue");
assert.strictEqual(dl.deadlineState("Completed", day(-5), today), undefined, "completed rows have no deadline");
assert.strictEqual(dl.deadlineState("Canceled", day(-5), today), undefined, "canceled rows are never overdue");
assert.strictEqual(dl.deadlineState("Neutral", day(-5), today), undefined, "rows without completion semantics are never overdue");
assert.strictEqual(dl.deadlineState("Active", null, today), undefined);
// Configured thresholds, including equal values that skip a colour.
const wide = { approaching: 7, near: 3, imminent: 1 };
assert.deepStrictEqual([8, 7, 4, 3, 2, 1, 0, -1].map(offset => level(offset, "Active", wide)), ["scheduled", "approaching", "approaching", "near", "near", "imminent", "imminent", "overdue"]);
assert.deepStrictEqual([3, 2, 1].map(offset => level(offset, "Active", { approaching: 2, near: 2, imminent: 2 })), ["scheduled", "imminent", "imminent"]);
assert.deepStrictEqual(dl.resolveThresholds({}), { thresholds: { approaching: 2, near: 1, imminent: 0 } }, "empty settings keep the defaults");
assert.deepStrictEqual(dl.resolveThresholds({ approaching: 7, near: null, imminent: undefined }), { thresholds: { approaching: 7, near: 1, imminent: 0 } });
assert.ok(dl.resolveThresholds({ approaching: 1.5 }).error);
assert.ok(dl.resolveThresholds({ approaching: 1, near: 2 }).error.includes("must not increase"));

// --- Text: singular and plural ---
const text = offset => dl.deadlineText(dl.deadlineState("Active", day(offset), today, wide));
assert.deepStrictEqual([-1, -2, -31, 0, 1, 2, 9].map(text), ["Overdue by 1 day", "Overdue by 2 days", "Overdue by 31 days", "Due today", "Due tomorrow", "Due in 2 days", "Due in 9 days"]);
// Day counts are calendar days, not 24-hour periods, across daylight saving changes.
assert.strictEqual(dl.daysUntil(new Date(2026, 2, 30), new Date(2026, 2, 28)), 2);
assert.strictEqual(dl.daysUntil(new Date(2026, 9, 26), new Date(2026, 9, 24)), 2);
assert.strictEqual(dl.lastOverdueDay(new Date(2026, 0, 1)), "2025-12-31", "the overdue filter's last day is the user's yesterday");

// --- The user's Dynamics zone decides the day, not the browser zone ---
const instant = new Date("2026-11-18T22:30:00Z");
assert.deepStrictEqual([600, 60, 0, -300].map(offset => dl.userCalendarDay(instant, offset).getDate()), [19, 18, 18, 18]);
assert.strictEqual(dl.userCalendarDay(new Date("2026-11-18T09:30:00Z"), -600).getDate(), 17, "UTC-10 is still the previous day");
assert.strictEqual(dl.toUserCalendarDate("2026-11-18T23:00:00Z", "timeZoneIndependent", () => 600).getDate(), 18, "time zone independent: no conversion");
assert.strictEqual(dl.toUserCalendarDate("2026-11-18", "dateOnly", () => -600).getDate(), 18, "Date Only: no conversion");
assert.strictEqual(dl.toUserCalendarDate(new Date("2026-11-18T23:00:00Z"), "userLocal", () => 120).getDate(), 19, "user local: converted to the user's day");
[null, undefined, "", "not a date"].forEach(empty => assert.strictEqual(dl.toUserCalendarDate(empty, "userLocal", () => 0), null));
// A task due "today" in a user zone east of the browser is not overdue, and the same rule holds a day later.
const userToday = dl.userCalendarDay(instant, 600);
const dueAtUserDay = dl.toUserCalendarDate(new Date("2026-11-18T23:00:00Z"), "userLocal", () => 600);
assert.strictEqual(dl.deadlineState("Active", dueAtUserDay, userToday).level, "imminent");
assert.strictEqual(dl.deadlineState("Active", dueAtUserDay, dl.userCalendarDay(new Date("2026-11-19T22:30:00Z"), 600)).level, "overdue");

// --- Choice labels come from metadata in every host shape; the value is always raw ---
const hostShape = { 0: { text: "Offen", value: 0 }, 1: { text: "Erledigt", value: 1 }, 2: { text: "Abgebrochen", value: 2 } };
assert.deepStrictEqual(choiceOptionsFromMetadata(hostShape), [{ value: "0", label: "Offen" }, { value: "1", label: "Erledigt" }, { value: "2", label: "Abgebrochen" }],
  "model-driven host shape (verified live): 3.6.0 showed the raw values 0, 1, 2 here");
assert.deepStrictEqual(choiceOptionsFromMetadata({ Options: [{ Value: 192350000, Label: { UserLocalizedLabel: { Label: "On Time" }, LocalizedLabels: [{ Label: "x" }] } }] }), [{ value: "192350000", label: "On Time" }]);
assert.deepStrictEqual(choiceOptionsFromMetadata({ Options: [{ Value: 5, Label: { UserLocalizedLabel: null, LocalizedLabels: [{ Label: "Completed" }] } }] }), [{ value: "5", label: "Completed" }]);
assert.deepStrictEqual(choiceOptionsFromMetadata({ 3: "In Progress" }), [{ value: "3", label: "In Progress" }]);
assert.deepStrictEqual(choiceOptionsFromMetadata({ 7: {} }), [{ value: "7", label: "7" }], "the raw value only when Dataverse returns no label");
assert.deepStrictEqual(choiceOptionsFromMetadata(null), []);

// --- Rendering: bars, overdue icon, tooltip text and legend share the calculation ---
const noop = () => {};
function render(props) {
  const originalError = console.error;
  console.error = message => { if (!String(message).includes("useLayoutEffect")) originalError(message); };
  try {
    return renderToStaticMarkup(React.createElement(Gantt, { allocatedHeight: 600, allocatedWidth: 1300, loading: false, filters: { status: "all", createdOn: "all", dueDate: "all" }, sorting: undefined,
      licenseState: "licensed", licenseMessage: "", onRevalidateLicense: noop, onFiltersChange: noop, onSortChange: noop, onRefresh: noop, onOpen: noop, refreshDisabled: false, refreshing: false, instanceId: "dl", today, ...props }));
  } finally { console.error = originalError; }
}
const task = (recordId, name, finishOffset, status = "Active", extra = {}) => ({ recordId, name, assignedTo: "A", status, statusLabel: extra.statusLabel ?? "Offen", start: day(finishOffset - 3), due: day(finishOffset), ...extra });
const tasks = [task("s", "Far", 6), task("a", "Two days", 2), task("n", "Tomorrow", 1), task("i", "Today", 0), task("o1", "One late", -1), task("o3", "Three late", -3),
  task("c", "Done late", -3, "Completed", { statusLabel: "Erledigt" }), task("x", "Dropped late", -3, "Canceled", { statusLabel: "Abgebrochen" }), task("u", "Unknown late", -3, "Neutral", { statusLabel: "Erledigt" })];
const html = render({ tasks, layout: TASK_LAYOUT, onLoadMore: noop });
const barClass = name => new RegExp(`class="tg-bar ([a-z]+)"[^>]*aria-label="${name}:`).exec(html)?.[1];
assert.deepStrictEqual(tasks.map(t => barClass(t.name)), ["scheduled", "approaching", "near", "imminent", "overdue", "overdue", "completed", "canceled", "neutral"]);
assert.deepStrictEqual(tasks.map(t => barTone(t, rowDeadline(t, today))), ["scheduled", "approaching", "near", "imminent", "overdue", "overdue", "completed", "canceled", "neutral"]);
assert.strictEqual(count(html, 'class="tg-urgency overdue"'), 2, "the warning icon marks overdue tasks only (not due today, completed, canceled or neutral)");
assert.ok(html.includes('class="tg-urgency overdue" role="img" tabindex="0" aria-label="Overdue by 1 day"'), "singular, focusable, named");
assert.ok(html.includes('aria-label="Overdue by 3 days"'), "plural");
const fmt = d => d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
assert.ok(html.includes(`aria-label="Three late: ${fmt(day(-6))} - ${fmt(day(-3))}. Overdue by 3 days — due ${fmt(day(-3))}"`), "bar label keeps the range and adds the deadline");
assert.ok(/aria-label="Today: [^"]*Due today/.test(html), "due today is described, not marked overdue");
assert.ok(/aria-label="Tomorrow: [^"]*Due tomorrow/.test(html));
assert.ok(/aria-label="One late: [^"]*Overdue by 1 day/.test(html), "bar text matches the icon");
assert.ok(!/aria-label="Done late: [^"]*Overdue/.test(html) && !/aria-label="Unknown late: [^"]*Overdue/.test(html));
assert.ok(html.includes('<span class="tg-status completed">Erledigt</span>') && html.includes('<span class="tg-status neutral">Erledigt</span>'), "status pills show the Dataverse label as returned");
// Footer: legend, Load more outside the scroll area; toolbar: Today.
const footer = html.slice(html.indexOf('<footer class="tg-footer">'));
assert.ok(footer.includes('aria-label="Colour legend"') && ["Scheduled", "Due soon", "Overdue", "Completed", "Canceled"].every(label => footer.includes(`</i>${label}</span>`)), "legend in the footer");
assert.ok(footer.includes('title="Yellow from 2 days before Due Date, orange from 1, dark orange from 0 (0 is the due day)"'));
assert.ok(footer.includes(">Load more</button>") && footer.includes('aria-label="Load the next 10 tasks"'), "Load more lives in the footer");
assert.ok(!html.slice(0, html.indexOf("<footer")).includes("tg-more"), "not inside the scrolling rows");
assert.ok(html.includes('aria-current="date"'), "today is marked in the calendar header");
assert.ok(html.includes("</svg>Today</button>"));
// Configured thresholds change colours and the legend text together.
const wideHtml = render({ tasks: [task("w", "Week", 6)], layout: TASK_LAYOUT, thresholds: { approaching: 7, near: 3, imminent: 1 } });
assert.ok(/class="tg-bar approaching"[^>]*aria-label="Week: [^"]*Due in 6 days/.test(wideHtml));
assert.ok(wideHtml.includes("Yellow from 7 days before Due Date, orange from 3, dark orange from 1"));
// Summary bars stay distinct from task colours; milestones take the deadline colour.
const custom = buildLayout(resolveFieldMap([...CUSTOM_COLUMNS, { name: "statecode", alias: "statecode", dataType: "OptionSet" }], "cr123_plan", { completedValues: "1" }));
const milestoneHtml = render({ layout: custom, tasks: [task("m", "Gate", -2, "Active", { isMilestone: true })] });
assert.ok(/class="tg-milestone overdue"[^>]*aria-label="Gate: milestone on [^"]*Overdue by 2 days . due/.test(milestoneHtml));
assert.ok(!custom.showCanceled && !milestoneHtml.includes("</i>Canceled</span>"), "no Canceled legend without canceled values");

console.log("TaskGantt deadline tests passed.");
