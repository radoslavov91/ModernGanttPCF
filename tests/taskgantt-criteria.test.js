// 3.6.0: search, column filters and record counts (server-side, through the PCF filtering API only).
const assert = require("assert");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadSource } = require("./helpers/loadTs");
const { TASK_COLUMNS, CUSTOM_COLUMNS, HIERARCHY_COLUMNS, makeDataset, makeContext, installWindowStub } = require("./helpers/mockDataset");

installWindowStub();
const { TaskGantt } = loadSource("index.ts");
const { Gantt } = loadSource("src/Gantt.tsx");
const { buildHierarchy } = loadSource("src/hierarchy.ts");
const { TASK_LAYOUT } = loadSource("src/fieldMap.ts");
const vc = loadSource("src/viewCriteria.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));
const noop = () => {};
const USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// --- Pure criteria logic ---
assert.strictEqual(vc.filterKind("SingleLine.Text"), "text");
assert.strictEqual(vc.filterKind("Multiple"), "text");
assert.strictEqual(vc.filterKind("OptionSet"), "choice");
assert.strictEqual(vc.filterKind("DateAndTime.DateOnly"), "date");
assert.strictEqual(vc.filterKind("Lookup.Simple"), undefined, "lookups are not offered");
assert.strictEqual(vc.filterKind("TwoOptions"), undefined);
assert.strictEqual(vc.containsPattern("50%_[x]"), "%50[%][_][[]x]%", "user wildcards are literal");
assert.deepStrictEqual(vc.conditionFor({ column: "d", kind: "date", operator: "on", value: "2026-03-01" }), { attributeName: "d", conditionOperator: 25, value: "2026-03-01" });
assert.deepStrictEqual(vc.conditionFor({ column: "d", kind: "date", operator: "before", value: "2026-03-01" }), { attributeName: "d", conditionOperator: 26, value: "2026-02-28" }, "Before is strictly before the day");
assert.deepStrictEqual(vc.conditionFor({ column: "d", kind: "date", operator: "after", value: "2024-02-28" }), { attributeName: "d", conditionOperator: 27, value: "2024-02-29" }, "After is strictly after the day");
assert.deepStrictEqual(vc.conditionFor({ column: "s", kind: "choice", operator: "is", value: "192350001", label: "Erledigt" }), { attributeName: "s", conditionOperator: 0, value: "192350001" }, "choices filter by raw value");
assert.deepStrictEqual(vc.normalizeCriteria({ search: "  a ", filters: [{ column: "z", kind: "text", operator: "equals", value: " x " }, { column: "d", kind: "date", operator: "on", value: "2026-02-30" }, { column: "c", kind: "choice", operator: "is", value: "Completed" }] }),
  { search: "a", filters: [{ column: "z", kind: "text", operator: "equals", value: "x" }] }, "invalid dates and non-numeric choice values are dropped");
assert.strictEqual(vc.describeFilter({ column: "s", kind: "choice", operator: "is", value: "1", label: "Erledigt" }, "Status"), "Status is Erledigt");

// Host filter derivation (Smart Grid 2.2.3 rules).
const host = { filterOperator: 0, conditions: [{ attributeName: "ownerid", conditionOperator: 0, value: "u1" }] };
const own = [{ attributeName: "subject", conditionOperator: 6, value: "%a%" }];
const expression = vc.buildFilterExpression(own, host);
assert.deepStrictEqual(expression, { filterOperator: 0, conditions: own, filters: [host] });
const applied = { expression, host, own };
assert.deepStrictEqual(vc.currentHostFilter(expression, applied), { host });
assert.deepStrictEqual(vc.currentHostFilter({ filterOperator: 0, conditions: [{ attributeName: "x", conditionOperator: 0, value: "1" }], filters: [expression] }, applied).host,
  { filterOperator: 0, conditions: [{ attributeName: "x", conditionOperator: 0, value: "1" }], filters: [host] }, "host wrapped the Gantt expression");
assert.deepStrictEqual(vc.currentHostFilter({ filterOperator: 0, conditions: [...own, { attributeName: "y", conditionOperator: 0, value: "2" }] }, applied).host,
  { filterOperator: 0, conditions: [{ attributeName: "y", conditionOperator: 0, value: "2" }] }, "host changed conditions beside the Gantt's own");
assert.strictEqual(vc.currentHostFilter(null, applied), "lost");
assert.strictEqual(vc.currentHostFilter({ filterOperator: 0, conditions: [{ attributeName: "q", conditionOperator: 0, value: "1" }] }, applied), "lost");
assert.deepStrictEqual(vc.buildFilterExpression([], host), host, "no own conditions: only the host filter remains");
assert.strictEqual(vc.buildFilterExpression([], null), null);

// Totals (cumulative Load more): only a total consistent with what is loaded is shown.
assert.strictEqual(vc.matchingTotal(126, 50, true), 126);
assert.strictEqual(vc.matchingTotal(126, 126, false), 126);
assert.strictEqual(vc.matchingTotal(50, 50, true), undefined, "a next page means more than is loaded");
assert.strictEqual(vc.matchingTotal(40, 50, false), undefined);
assert.strictEqual(vc.matchingTotal(-1, 50, true), undefined, "the host reports -1 when it has no count");
assert.strictEqual(vc.matchingTotal(5000, 50, true), "capped");
assert.strictEqual(vc.recordCountText(50, 126), "50 loaded · 126 matching records");
assert.strictEqual(vc.recordCountText(1, 1), "1 loaded · 1 matching record");
assert.strictEqual(vc.recordCountText(50, "capped"), "50 loaded · 5,000+ matching records (count limit reached)");
assert.strictEqual(vc.recordCountText(50, undefined), "50 loaded · matching total unavailable");
assert.strictEqual(vc.recordCountText(50, 126, 12), "50 loaded · 126 matching records · 12 visible");

// --- Host stand-ins: metadata (column security + choices) and a dataset that reports its filter ---
function installFetch(attributes, privileges = []) {
  const requests = [];
  global.fetch = async url => {
    requests.push(url);
    const body = url.includes("RetrievePrincipalAttributePrivileges") ? { AttributePrivileges: privileges } : { value: attributes };
    return { ok: true, json: async () => body };
  };
  return requests;
}
const attr = (LogicalName, extra = {}) => ({ LogicalName, MetadataId: `m-${LogicalName}`, IsSecured: false, IsValidForAdvancedFind: { Value: true }, ...extra });
const CHOICES = {
  statecode: [{ Value: 0, Label: { UserLocalizedLabel: { Label: "Offen" } } }, { Value: 1, Label: { UserLocalizedLabel: { Label: "Erledigt" } } }, { Value: 2, Label: { UserLocalizedLabel: { Label: "Abgebrochen" } } }],
  cr123_phase: [{ Value: 100000000, Label: { UserLocalizedLabel: { Label: "Design" } } }, { Value: 100000001, Label: { UserLocalizedLabel: { Label: "Build" } } }]
};
function hostContext(ds, { searchColumn, hostFilter = null, getFilter = true } = {}) {
  const ctx = makeContext(ds, { licenseKey: "" });
  ctx.page = { getClientUrl: () => "https://contoso.crm4.dynamics.com/" };
  ctx.userSettings = { userId: `{${USER.toUpperCase()}}` };
  ctx.utils = { getEntityMetadata: async (table, [name]) => ({ Attributes: { get: key => key === name && CHOICES[name] ? { OptionSet: { Options: CHOICES[name] } }
    : key === name && name === "cr123_code" ? { AttributeType: 14, DisplayName: "Code" } : key === name && name === "cr123_amount" ? { AttributeType: 2, DisplayName: "Amount" } : undefined } }) };
  if (searchColumn !== undefined) ctx.parameters.searchColumn = { raw: searchColumn };
  let current = hostFilter;
  if (getFilter) {
    ds.filtering.getFilter = () => current;
    const set = ds.filtering.setFilter, clear = ds.filtering.clearFilter;
    ds.filtering.setFilter = filter => { current = filter; set(filter); };
    ds.filtering.clearFilter = () => { current = null; clear(); };
  }
  return { ctx, setHostFilter: filter => { current = filter; }, currentFilter: () => current };
}
// A licensed control: the licence gate is not under test here.
function licensedControl(ctx) {
  const control = new TaskGantt();
  control.init(ctx, noop);
  control.licenseState = "licensed";
  control.activeLicenseFingerprint = "test";
  control.ensureLicenseValidation = noop;
  return control;
}

(async () => {
  // --- Standard Tasks: columns offered by type and permission; Status uses metadata options ---
  {
    const columns = [...TASK_COLUMNS, { name: "description", dataType: "Multiple", displayName: "Description" }, { name: "regardingobjectid", dataType: "Lookup.Simple", displayName: "Regarding" },
      { name: "a_1.name", dataType: "SingleLine.Text", displayName: "Account name" }, { name: "new_secret", dataType: "SingleLine.Text", displayName: "Secret" }, { name: "new_secret2", dataType: "SingleLine.Text", displayName: "Readable secret" },
      { name: "new_hidden", dataType: "SingleLine.Text", displayName: "Not searchable" }];
    const requests = installFetch([attr("subject"), attr("scheduledend"), attr("ownerid"), attr("statecode"), attr("scheduledstart"), attr("createdon"), attr("description"), attr("regardingobjectid"),
      attr("new_secret", { IsSecured: true }), attr("new_secret2", { IsSecured: true }), attr("new_hidden", { IsValidForAdvancedFind: { Value: false } })],
    [{ AttributeId: "m-new_secret2", CanRead: 4 }, { AttributeId: "m-new_secret", CanRead: 0 }]);
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, values: { subject: `Task ${i}`, statecode: i % 2 } }));
    const { ds, calls } = makeDataset({ entityType: "task", columns, rows, hasNextPage: true });
    ds.paging.totalResultCount = 126;
    const hostFilter = { filterOperator: 0, conditions: [{ attributeName: "ownerid", conditionOperator: 41, value: "" }] };    // e.g. Edit filters: owner = current user
    const { ctx, setHostFilter, currentFilter } = hostContext(ds, { searchColumn: "subject", hostFilter });
    const control = licensedControl(ctx);
    let props = control.updateView(ctx).props;
    assert.deepStrictEqual(props.filterColumns, [], "nothing is offered before permissions are known");
    await tick(); await tick();
    props = control.updateView(ctx).props;                       // permissions known: choice options are requested
    assert.strictEqual(props.filterColumns.find(c => c.name === "statecode").options, undefined, "options loading");
    await tick();
    props = control.updateView(ctx).props;
    assert.ok(requests[0].startsWith("https://contoso.crm4.dynamics.com/api/data/v9.2/EntityDefinitions(LogicalName='task')/Attributes?$select=LogicalName,MetadataId,IsSecured,IsValidForAdvancedFind"));
    assert.ok(requests.some(url => url.includes(`systemusers(${USER})/Microsoft.Dynamics.CRM.RetrievePrincipalAttributePrivileges()`)));
    assert.deepStrictEqual(props.filterColumns.map(c => [c.name, c.kind]), [["subject", "text"], ["scheduledend", "date"], ["statecode", "choice"], ["scheduledstart", "date"], ["createdon", "date"], ["description", "text"], ["new_secret2", "text"]],
      "lookups, linked-table columns, secured columns without read and non-searchable columns are not offered");
    assert.deepStrictEqual(props.filterColumns.find(c => c.name === "statecode").options, [{ value: "0", label: "Offen" }, { value: "1", label: "Erledigt" }, { value: "2", label: "Abgebrochen" }], "metadata options, localized labels, raw values");
    assert.deepStrictEqual(props.search, { label: "Subject" });
    assert.strictEqual(props.recordCount.loaded, 10);
    assert.strictEqual(props.recordCount.total, 126);

    // Search + a choice filter + a toolbar filter: one expression ANDed with the host filter, back to page 1.
    const before = { reset: calls.reset, refresh: calls.refresh };
    props.onCriteriaChange({ search: " Survey ", filters: [{ column: "statecode", kind: "choice", operator: "is", value: "2", label: "Abgebrochen" }] });
    let written = calls.setFilter.pop();
    assert.deepStrictEqual(written, { filterOperator: 0, conditions: [
      { attributeName: "subject", conditionOperator: 6, value: "%Survey%" },
      { attributeName: "statecode", conditionOperator: 0, value: "2" }], filters: [hostFilter] });
    assert.deepStrictEqual([calls.reset - before.reset, calls.refresh - before.refresh], [1, 1], "returns to page 1 and queries every page");
    ds.loading = true;
    props = control.updateView(ctx).props;
    assert.deepStrictEqual(props.recordCount, { loaded: 10, total: 126, updating: true }, "the last count stays visible while loading");
    ds.loading = false; ds.paging.totalResultCount = 3; ds.paging.hasNextPage = false; ds.sortedRecordIds = ["t0", "t1", "t2"];
    props = control.updateView(ctx).props;
    assert.deepStrictEqual(props.recordCount, { loaded: 3, total: 3, updating: false });
    assert.deepStrictEqual(props.filteredFields.sort(), ["status", "title"], "header indicators for Status and the searched title");
    props.onFiltersChange({ status: "completed", createdOn: "all", dueDate: "all" });
    written = calls.setFilter.pop();
    assert.deepStrictEqual(written.conditions.map(c => [c.attributeName, c.conditionOperator, c.value]), [["statecode", 0, "1"], ["subject", 6, "%Survey%"], ["statecode", 0, "2"]], "toolbar filters and criteria combine");
    assert.deepStrictEqual(written.filters, [hostFilter], "host filter preserved");

    // The host changes its own filter beside ours (e.g. Edit filters): the next change keeps the new host filter.
    const newHost = { attributeName: "prioritycode", conditionOperator: 0, value: "2" };
    setHostFilter({ ...currentFilter(), conditions: [...currentFilter().conditions, newHost] });
    props = control.updateView(ctx).props;
    props.onCriteriaChange({ search: "Survey", filters: [] });
    written = calls.setFilter.pop();
    assert.deepStrictEqual(written.conditions.map(c => c.attributeName), ["statecode", "subject"]);
    assert.ok(JSON.stringify(written.filters).includes("prioritycode") && JSON.stringify(written.filters).includes("ownerid"), "both host conditions survive");

    // Clear all filters: the host filter alone is written back.
    props = control.updateView(ctx).props;
    props.onClearAll();
    written = calls.setFilter.pop();
    assert.ok(!JSON.stringify(written).includes("subject") && !JSON.stringify(written).includes("statecode"));
    assert.ok(JSON.stringify(written).includes("ownerid") && JSON.stringify(written).includes("prioritycode"));
    props = control.updateView(ctx).props;
    assert.deepStrictEqual([props.criteria, props.filters], [{ search: "", filters: [] }, { status: "all", createdOn: "all", dueDate: "all" }]);

    // The host replaces our conditions: the Gantt clears its own criteria, says so and writes nothing.
    props.onCriteriaChange({ search: "Survey", filters: [] });
    const writes = calls.setFilter.length;
    setHostFilter({ filterOperator: 0, conditions: [{ attributeName: "subject", conditionOperator: 0, value: "Other" }] });
    props = control.updateView(ctx).props;
    assert.deepStrictEqual(props.criteria, { search: "", filters: [] });
    assert.ok(props.criteriaNotice.startsWith("The view's filters were changed outside the Gantt"));
    assert.strictEqual(calls.setFilter.length, writes, "no guessed filter is written");
  }

  // --- Custom table: Date Only filters, choice options, search column outside the view and type checks ---
  {
    const columns = [...CUSTOM_COLUMNS, { name: "cr123_phase", dataType: "OptionSet", displayName: "Phase" }];
    installFetch(["cr123_name", "cr123_plannedstart", "cr123_plannedfinish", "cr123_phase", "cr123_code", "cr123_amount"].map(name => attr(name)));
    const { ds, calls } = makeDataset({ entityType: "cr123_plan", columns, rows: [{ id: "c1", values: { cr123_name: "A" } }] });
    const { ctx } = hostContext(ds, { searchColumn: "cr123_code" });
    const control = licensedControl(ctx);
    control.updateView(ctx);
    await tick(); await tick();
    control.updateView(ctx);
    await tick();
    let props = control.updateView(ctx).props;
    assert.deepStrictEqual(props.search, { label: "Code" }, "a text column outside the view is verified from metadata");
    assert.deepStrictEqual(props.filterColumns.find(c => c.name === "cr123_phase").options.map(o => o.label), ["Design", "Build"]);
    props.onCriteriaChange({ search: "", filters: [{ column: "cr123_plannedfinish", kind: "date", operator: "before", value: "2026-12-01" }, { column: "cr123_phase", kind: "choice", operator: "is", value: "100000001", label: "Build" }] });
    assert.deepStrictEqual(calls.setFilter.pop(), { filterOperator: 0, filters: [], conditions: [
      { attributeName: "cr123_phase", conditionOperator: 0, value: "100000001" },
      { attributeName: "cr123_plannedfinish", conditionOperator: 26, value: "2026-11-30" }] }, "no host filter: only the Gantt's conditions");
    assert.strictEqual(props.recordCount.total, undefined, "no reported total is labelled unavailable");

    const { ctx: numberCtx } = hostContext(ds, { searchColumn: "cr123_amount" });
    const numberControl = licensedControl(numberCtx);
    numberControl.updateView(numberCtx); await tick(); await tick();
    assert.deepStrictEqual(numberControl.updateView(numberCtx).props.search, { error: "Search is unavailable: Amount is not a text column." });
    const { ctx: badCtx } = hostContext(ds, { searchColumn: "cr123 name" });
    assert.ok(licensedControl(badCtx).updateView(badCtx).props.search.error.includes("not a column logical name"));
    const { ctx: phaseCtx } = hostContext(ds, { searchColumn: "cr123_phase" });
    assert.deepStrictEqual(licensedControl(phaseCtx).updateView(phaseCtx).props.search, { error: "Search is unavailable: Phase is not a text column." });
  }

  // --- Hosts that cannot report their filter: nothing is offered, toolbar filters behave as in 3.5.0 ---
  {
    installFetch([attr("cr123_name")]);
    const { ds } = makeDataset({ entityType: "cr123_plan", columns: CUSTOM_COLUMNS, rows: [] });
    const { ctx } = hostContext(ds, { searchColumn: "cr123_name", getFilter: false });
    const control = licensedControl(ctx);
    control.updateView(ctx); await tick(); await tick();
    const props = control.updateView(ctx).props;
    assert.deepStrictEqual(props.filterColumns, []);
    assert.ok(props.search.error.includes("does not let the Gantt filter"));
  }

  // --- Permissions cannot be verified: nothing is offered and the reason is shown ---
  {
    global.fetch = async () => ({ ok: false, json: async () => ({}) });
    const { ds } = makeDataset({ entityType: "cr123_plan", columns: CUSTOM_COLUMNS, rows: [] });
    const { ctx } = hostContext(ds, { searchColumn: "cr123_name" });
    const control = licensedControl(ctx);
    control.updateView(ctx); await tick(); await tick();
    const props = control.updateView(ctx).props;
    assert.deepStrictEqual(props.filterColumns, []);
    assert.deepStrictEqual(props.search, { error: "Search is unavailable: column permissions could not be verified." });
    assert.ok(props.criteriaNotice.includes("column permissions could not be verified"));
  }

  // --- Rendering: labelled search, filter button, chips, Clear all, header indicator, count in the toolbar ---
  {
    const render = props => {
      const originalError = console.error;
      console.error = message => { if (!String(message).includes("useLayoutEffect")) originalError(message); };
      try {
        return renderToStaticMarkup(React.createElement(Gantt, { allocatedHeight: 600, allocatedWidth: 1200, loading: false, filters: { status: "all", createdOn: "all", dueDate: "all" }, sorting: undefined,
          licenseState: "licensed", licenseMessage: "", onRevalidateLicense: noop, onFiltersChange: noop, onSortChange: noop, onRefresh: noop, onOpen: noop, onCriteriaChange: noop, onClearAll: noop,
          refreshDisabled: false, refreshing: false, instanceId: "crit", layout: TASK_LAYOUT, tasks: [], ...props }));
      } finally { console.error = originalError; }
    };
    const filterColumns = [{ name: "subject", label: "Subject", kind: "text" }, { name: "statecode", label: "Activity Status", kind: "choice", options: [{ value: "1", label: "Erledigt" }] }];
    let html = render({ search: { label: "Subject" }, filterColumns, recordCount: { loaded: 50, total: 126, updating: false } });
    assert.ok(html.includes('role="search"') && html.includes('<span class="tg-visually-hidden">Search Subject</span>') && html.includes('aria-label="Search Subject (contains)"') && html.includes('placeholder="Search Subject…"'));
    assert.ok(html.includes("</svg>Filters</button>") && html.includes('aria-haspopup="dialog"'));
    assert.ok(html.includes('role="status" aria-live="polite">50 loaded · 126 matching records</span>'), "count in the toolbar");
    assert.ok(!html.includes("Clear all filters") && !html.includes("tg-chip"));
    html = render({ search: { label: "Subject" }, filterColumns, criteria: { search: "Survey", filters: [{ column: "statecode", kind: "choice", operator: "is", value: "1", label: "Erledigt" }] }, filteredFields: ["title", "status"],
      recordCount: { loaded: 3, total: 3, updating: false } });
    assert.ok(html.includes("Subject contains “Survey”") && html.includes('aria-label="Clear search: Subject contains “Survey”"'));
    assert.ok(html.includes(">Activity Status is Erledigt</button>") && html.includes('aria-label="Clear filter: Activity Status is Erledigt"'), "chip shows the localized label");
    assert.ok(html.includes("</svg>Filters (1)</button>") && html.includes(">Clear all filters</button>"));
    assert.strictEqual(html.split('class="tg-filter-mark"').length - 1, 2, "Task name and Status headers are marked");
    assert.ok(html.includes("No tasks match the search and filters"));
    // A toolbar-only filter also offers Clear all filters when the host supports criteria.
    html = render({ filters: { status: "completed", createdOn: "all", dueDate: "all" } });
    assert.ok(html.includes(">Clear all filters</button>"));
    // Without criteria support (older hosts and the 3.5.0 test props) the toolbar keeps its 3.5.0 Clear filters button.
    html = render({ filters: { status: "completed", createdOn: "all", dueDate: "all" }, onClearAll: undefined, onCriteriaChange: undefined });
    assert.ok(html.includes(">Clear filters</button>") && !html.includes("tg-criteria"));
    // Unavailable and capped totals are labelled; a hierarchy that is fully expanded shows no visible count.
    assert.ok(render({ recordCount: { loaded: 10, total: undefined, updating: false } }).includes("10 loaded · matching total unavailable"));
    assert.ok(render({ recordCount: { loaded: 50, total: "capped", updating: true } }).includes('class="tg-count is-updating"'));
    const tasks = [{ recordId: "p", name: "Parent", assignedTo: "", status: "Active", start: new Date(2026, 0, 5), due: new Date(2026, 0, 9), parent: null },
      { recordId: "c", name: "Child", assignedTo: "", status: "Active", start: new Date(2026, 0, 5), due: new Date(2026, 0, 6), parent: { id: "p" } }];
    html = render({ tasks, hierarchy: buildHierarchy(tasks, { useSequence: false }), recordCount: { loaded: 2, total: 2, updating: false } });
    assert.ok(html.includes(">2 loaded · 2 matching records</span>"));
  }

  // --- Existing configurations without a search column or metadata access keep working ---
  {
    const { ds } = makeDataset({ entityType: "simetrix_gantttestitem", columns: HIERARCHY_COLUMNS, rows: [] });
    const ctx = makeContext(ds);
    const control = new TaskGantt();
    control.init(ctx, noop);
    const props = control.updateView(ctx).props;
    assert.deepStrictEqual([props.search, props.filterColumns], [undefined, []]);
  }

  console.log("TaskGantt criteria tests passed.");
})().catch(error => { console.error(error); process.exit(1); });
