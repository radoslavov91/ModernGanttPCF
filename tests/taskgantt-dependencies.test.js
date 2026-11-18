// Phase 3: read-only dependency lines (shared link engine, Project Operations defaults, custom link tables).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadSource } = require("./helpers/loadTs");
const { CUSTOM_COLUMNS, HIERARCHY_COLUMNS, PROJECT_TASK_COLUMNS, makeDataset, makeContext, installWindowStub } = require("./helpers/mockDataset");

installWindowStub();
const { TaskGantt } = loadSource("index.ts");
const { Gantt } = loadSource("src/Gantt.tsx");
const { buildLayout, resolveFieldMap } = loadSource("src/fieldMap.ts");
const { buildHierarchy } = loadSource("src/hierarchy.ts");
const deps = loadSource("src/dependencies.ts");
const { DependencyLoader } = loadSource("src/dependencyLoader.ts");
const { PROJECT_OPERATIONS_LINKS, customLinkSource, parseLinkRow, buildLinkFetchXml, layoutDependencies, representatives, routePath, describeSkipped } = deps;

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "po-dependencies.json"), "utf8"));
const T = Object.fromEntries(fixture.tasks.map(t => [t.name.replace("555 - ", "").split(" ")[0].toLowerCase(), t]));
const tick = () => new Promise(resolve => setImmediate(resolve));
const noop = () => {};
const count = (text, fragment) => text.split(fragment).length - 1;
const scoped = (scope, ids) => ids.map(id => ({ id, scope }));

// Parses the link FetchXML: the project scope (eq or in) and the predecessor/successor task-id lists.
function parseLinkFetch(fetchXml) {
  const values = block => new Set([...block.matchAll(/<value>([^<]+)<\/value>/g)].map(m => m[1]));
  const eq = /attribute="msdyn_project" operator="eq" value="([^"]+)"/.exec(fetchXml);
  const inList = /<condition attribute="msdyn_project" operator="in">(.*?)<\/condition>/.exec(fetchXml);
  const projects = eq ? new Set([eq[1]]) : inList ? values(inList[1]) : undefined;
  const ends = [...fetchXml.matchAll(/<condition attribute="([^"]+)" operator="in">(.*?)<\/condition>/g)].filter(m => m[1] !== "msdyn_project");
  return { projects, pred: ends[0][1], succ: ends[1][1], ids: values(ends[0][2]) };
}

// A Web API stand-in that answers link FetchXML from the fixture, honouring the project and task-id filters. Rows may
// carry _msdyn_project_value; otherwise they belong to `project`.
function makeWebApi(rows, { fail = false, project = fixture.project } = {}) {
  const calls = [];
  return {
    calls,
    retrieveMultipleRecords: async (table, options) => {
      const fetchXml = decodeURIComponent(options.replace("?fetchXml=", ""));
      calls.push({ table, fetchXml });
      if (fail) throw new Error("Principal user is missing prvReadmsdyn_projecttaskdependency privilege.");
      const { projects, pred, succ, ids } = parseLinkFetch(fetchXml);
      return { entities: rows.filter(r => (!projects || projects.has(r._msdyn_project_value ?? project)) && (ids.has(r[`_${pred}_value`]) || ids.has(r[`_${succ}_value`]))) };
    }
  };
}

(async () => {
  // --- Link types: all four verified values, cross-checked against the mirror column ---
  const base = fixture.links[2];
  for (const variant of fixture.typeVariants) {
    const { link, skipped } = parseLinkRow(PROJECT_OPERATIONS_LINKS, { ...base, msdyn_linktype: variant.msdyn_linktype, msdyn_projecttaskdependencylinktype: variant.msdyn_projecttaskdependencylinktype });
    assert.strictEqual(skipped, undefined, `${variant.label} is accepted`);
    assert.strictEqual(link.type, variant.label);
  }
  for (const variant of fixture.invalidVariants) {
    const { link, skipped } = parseLinkRow(PROJECT_OPERATIONS_LINKS, { ...base, msdyn_linktype: variant.msdyn_linktype, msdyn_projecttaskdependencylinktype: variant.msdyn_projecttaskdependencylinktype });
    assert.strictEqual(link, undefined, `${variant.expect} ${variant.value} is skipped`);
    assert.deepStrictEqual(skipped, { id: base.msdyn_projecttaskdependencyid, reason: variant.expect, value: variant.value });
  }
  assert.strictEqual(parseLinkRow(PROJECT_OPERATIONS_LINKS, { ...base, msdyn_projecttaskdependencylinktype: null }).link.type, "FS", "mirror missing: authoritative column wins");
  assert.strictEqual(parseLinkRow(PROJECT_OPERATIONS_LINKS, { ...base, _msdyn_successortask_value: null }).skipped.reason, "missingEndpoint");
  const parsed = parseLinkRow(PROJECT_OPERATIONS_LINKS, base).link;
  assert.deepStrictEqual(parsed, { id: "c9b062fe-cacd-494f-a434-72e0255f1997", predecessorId: T.store.id, successorId: T.material.id, type: "FS", predecessorName: "555 - Store Design", successorName: "555 - Material Sourcing" });
  const unnamed = parseLinkRow(PROJECT_OPERATIONS_LINKS, { ...base, "_msdyn_successortask_value@OData.Community.Display.V1.FormattedValue": undefined }).link;
  assert.ok(!("successorName" in unnamed), "no invented successor name");
  assert.strictEqual(describeSkipped([{ id: "a", reason: "unknownType", value: "192350003" }, { id: "b", reason: "unknownType", value: "192350003" }, { id: "c", reason: "conflictingType", value: "192350000/3" }]),
    "2 with unknown link type 192350003; 1 with conflicting link types 192350000/3");

  // --- Custom link tables: opt in with three logical names, Finish-to-Start only ---
  assert.deepStrictEqual(customLinkSource({}), {});
  const custom = customLinkSource({ table: " cr123_TaskLink ", predecessorColumn: "cr123_predecessor", successorColumn: "cr123_successor" }).source;
  assert.deepStrictEqual(custom, { kind: "custom", table: "cr123_tasklink", idColumn: "cr123_tasklinkid", predecessorColumn: "cr123_predecessor", successorColumn: "cr123_successor" });
  assert.strictEqual(parseLinkRow(custom, { cr123_tasklinkid: "L1", _cr123_predecessor_value: "a", _cr123_successor_value: "b", cr123_linktype: 192350001 }).link.type, "FS", "custom links are always Finish-to-Start");
  assert.ok(customLinkSource({ table: "cr123_tasklink" }).error.includes("Predecessor column, Successor column"));
  assert.ok(customLinkSource({ table: "cr123 tasklink", predecessorColumn: "a", successorColumn: "b" }).error.includes("logical names"));

  // --- FetchXML: Project Operations reads are scoped to the project and the loaded tasks, active links only ---
  const poFetch = buildLinkFetchXml(PROJECT_OPERATIONS_LINKS, ["{BF1FEEB9-C752-41BA-9610-534657EFEDDE}"], fixture.project);
  assert.ok(poFetch.includes('<entity name="msdyn_projecttaskdependency">'));
  assert.ok(poFetch.includes('<condition attribute="statecode" operator="eq" value="0" />'));
  assert.ok(poFetch.includes(`<condition attribute="msdyn_project" operator="eq" value="${fixture.project}" />`));
  assert.ok(poFetch.includes(`<value>${T.store.id}</value>`) && poFetch.includes('<attribute name="msdyn_projecttaskdependencylinktype" />'));
  assert.ok(!buildLinkFetchXml(custom, ["a"]).includes("msdyn_project"), "custom tables have no project scope");

  // --- Loader: batches of 50, links deduplicated across pages, Load more only reads new tasks ---
  {
    const many = Array.from({ length: 120 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
    const api = makeWebApi(fixture.links);
    let changes = 0;
    const loader = new DependencyLoader(api, () => { changes += 1; });
    loader.sync(PROJECT_OPERATIONS_LINKS, scoped(fixture.project, [...many, T.store.id]));
    assert.strictEqual(loader.view().status, "loading");
    await tick();
    assert.strictEqual(api.calls.length, 3, "121 tasks are read in 3 batches");
    assert.ok(changes >= 1);
    // Store Design is the successor of Deed Reviews and the predecessor of Material Sourcing.
    assert.deepStrictEqual(loader.view().links.map(l => l.id).sort(), ["73d6dbe6-3ac3-4302-81fb-f2d77a205e17", "c9b062fe-cacd-494f-a434-72e0255f1997"]);

    loader.sync(PROJECT_OPERATIONS_LINKS, scoped(fixture.project, [...many, T.store.id]));
    await tick();
    assert.strictEqual(api.calls.length, 3, "already-read tasks are not read again");

    // Load more brings Material Sourcing: its links are read once, the shared link is not duplicated.
    loader.sync(PROJECT_OPERATIONS_LINKS, scoped(fixture.project, [...many, T.store.id, T.material.id, T.deed.id]));
    await tick();
    assert.strictEqual(api.calls.length, 4);
    assert.deepStrictEqual(loader.view().links.map(l => l.id).sort(), ["73d6dbe6-3ac3-4302-81fb-f2d77a205e17", "c9b062fe-cacd-494f-a434-72e0255f1997", "5743710e-afb9-4e16-9ef2-2e9856aeb300"].sort());
    assert.strictEqual(loader.view().status, "ready");

    // A refresh resets the cache; an answer that arrives after it is ignored.
    loader.sync(PROJECT_OPERATIONS_LINKS, scoped(fixture.project, [T.health.id]));
    loader.reset();
    await tick();
    assert.deepStrictEqual(loader.view().links, [], "stale answer after reset is ignored");
    // Another project scope starts from scratch.
    loader.sync(PROJECT_OPERATIONS_LINKS, scoped("11111111-1111-1111-1111-111111111111", [T.store.id]));
    await tick();
    assert.deepStrictEqual(loader.view().links, [], "links are only read within the current project");
  }
  {
    const api = makeWebApi(fixture.links, { fail: true });
    const loader = new DependencyLoader(api, noop);
    loader.sync(PROJECT_OPERATIONS_LINKS, scoped(fixture.project, [T.store.id]));
    await tick();
    assert.strictEqual(loader.view().status, "error");
    assert.ok(loader.view().message.includes("prvReadmsdyn_projecttaskdependency"));
    loader.sync(PROJECT_OPERATIONS_LINKS, scoped(fixture.project, [T.material.id]));
    await tick();
    assert.strictEqual(api.calls.length, 1, "no retry storm after a failed read");
  }
  {
    const rows = [...fixture.links, { ...fixture.links[0], msdyn_projecttaskdependencyid: "99999999-0000-0000-0000-000000000001", msdyn_linktype: 192350003 }];
    const loader = new DependencyLoader(makeWebApi(rows), noop);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = message => warnings.push(message);
    try {
      loader.sync(PROJECT_OPERATIONS_LINKS, scoped(fixture.project, [T.building.id]));
      await tick();
    } finally { console.warn = originalWarn; }
    assert.deepStrictEqual(loader.view().skipped, [{ id: "99999999-0000-0000-0000-000000000001", reason: "unknownType", value: "192350003" }]);
    assert.deepStrictEqual(warnings, ["TaskGantt skipped 1 dependency link(s): 1 with unknown link type 192350003."], "unknown values are reported once");
  }

  // --- Layout: anchors, stubs, reconnect, collapse, merge ---
  const links = fixture.links.map(row => parseLinkRow(PROJECT_OPERATIONS_LINKS, row).link);
  const flatReps = ids => representatives(undefined, ids, new Set());
  const rowsFor = list => list.map((t, rowIndex) => ({ recordId: t.id, rowIndex, start: rowIndex * 100, end: rowIndex * 100 + 80 }));
  const names = new Map(fixture.tasks.map(t => [t.id, t.name]));

  // Filtered: Material Sourcing is not loaded, so Store Design gets a stub on its finish side.
  const partial = [T.building, T.deed, T.store];
  let out = layoutDependencies(links, rowsFor(partial), flatReps(partial.map(t => t.id)), names);
  assert.deepStrictEqual(out.lines.map(l => `${l.fromRow}>${l.toRow}`), ["0>1", "1>2"]);
  assert.deepStrictEqual(out.stubs.map(s => [s.rowIndex, s.side, s.x]), [[2, "end", 280]]);
  assert.strictEqual(out.stubs[0].title, "Successor 555 - Material Sourcing is not in the loaded rows (Finish-to-Start)");
  assert.strictEqual(out.notLoaded, 1, "Store Design -> Material Sourcing counts; the Health & Safety link has neither end loaded and is ignored");
  // After Load more the stub reconnects as a line.
  const full = [T.building, T.deed, T.store, T.material];
  out = layoutDependencies(links, rowsFor(full), flatReps(full.map(t => t.id)), names);
  assert.strictEqual(out.lines.length, 3);
  assert.strictEqual(out.stubs.length, 0);
  assert.deepStrictEqual(out.lines.map(l => l.title), [
    "555 - Building Permits - renamed → 555 - Deed Reviews, Finish-to-Start",
    "555 - Deed Reviews → 555 - Store Design, Finish-to-Start",
    "555 - Store Design → 555 - Material Sourcing, Finish-to-Start"]);

  // All four link types anchor on the right sides.
  for (const [type, fromSide, toSide, x1, x2] of [["FS", "end", "start", 80, 100], ["SS", "start", "start", 0, 100], ["FF", "end", "end", 80, 180], ["SF", "start", "end", 0, 180]]) {
    const line = layoutDependencies([{ ...links[2], type }], rowsFor([T.store, T.material]), flatReps([T.store.id, T.material.id]), names).lines[0];
    assert.deepStrictEqual([line.fromSide, line.toSide, line.x1, line.x2], [fromSide, toSide, x1, x2], type);
    assert.ok(line.title.endsWith(deps.LINK_TYPE_LABELS[type]));
  }
  // Unscheduled end: no line, counted.
  out = layoutDependencies([links[2]], [{ recordId: T.store.id, rowIndex: 0, start: null, end: null }, { recordId: T.material.id, rowIndex: 1, start: 100, end: 180 }], flatReps([T.store.id, T.material.id]), names);
  assert.deepStrictEqual([out.lines.length, out.unscheduled], [0, 1]);

  // Collapse: both ends inside Planning Activities -> suppressed; one end outside -> dashed to the collapsed parent, merged.
  const tasks = fixture.tasks.map(t => ({ recordId: t.id, name: t.name, assignedTo: "", status: "Active", start: new Date(t.start), due: new Date(t.finish), parent: t.parent ? { id: t.parent } : null, sequence: t.sequence, isSummary: t.summary }));
  const tree = buildHierarchy(tasks, { useSequence: true });
  const visibleWhenCollapsed = [T.planning, T.project, T.health, T.hazardous];
  out = layoutDependencies(links, rowsFor(visibleWhenCollapsed), representatives(tree, [], new Set([T.planning.id])), names);
  assert.deepStrictEqual(out.lines.map(l => l.title), ["555 - Health & Safety inspection → 555 - Hazardous materials inspection, Finish-to-Start"]);
  assert.strictEqual(out.hiddenInCollapsed, 3, "links inside the same collapsed group are suppressed");
  const crossLinks = [{ ...links[2], id: "x1", successorId: T.health.id }, { ...links[1], id: "x2", successorId: T.health.id }];
  out = layoutDependencies(crossLinks, rowsFor(visibleWhenCollapsed), representatives(tree, [], new Set([T.planning.id])), names);
  assert.strictEqual(out.lines.length, 1, "two links from the same collapsed group merge");
  assert.deepStrictEqual([out.lines[0].fromRow, out.lines[0].toRow, out.lines[0].viaCollapsed, out.lines[0].count], [0, 2, true, 2]);
  assert.ok(out.lines[0].title.startsWith("2 links: 555 - Planning Activities → 555 - Health & Safety inspection"));

  // --- Routing ---
  assert.strictEqual(routePath(80, 23, 100, 69, "end", "start"), "M80 23 H88 V69 H100", "forward Finish-to-Start");
  // Same-day: Building Permits finishes on 15 Sep, Deed Reviews starts on 15 Sep, so the successor starts left of the end.
  const sameDay = routePath(380, 23, 342, 69, "end", "start");
  assert.strictEqual(sameDay, "M380 23 H388 V46 H334 V69 H342", "loops between the rows and enters from the left");
  assert.strictEqual(routePath(0, 23, 100, 69, "start", "start"), "M0 23 H-8 V69 H100", "Start-to-Start leaves to the left");
  assert.strictEqual(routePath(80, 23, 180, 69, "end", "end"), "M80 23 H188 V69 H180", "Finish-to-Finish enters from the right");
  assert.strictEqual(routePath(0, 23, 180, 69, "start", "end"), "M0 23 H-8 V46 H188 V69 H180", "Start-to-Finish loops when it cannot reach the right side directly");

  // --- Rendering ---
  const poMap = resolveFieldMap(PROJECT_TASK_COLUMNS, "msdyn_projecttask");
  function render(props) {
    const originalError = console.error;
    console.error = message => { if (!String(message).includes("useLayoutEffect")) originalError(message); };
    try {
      return renderToStaticMarkup(React.createElement(Gantt, {
        allocatedHeight: 600, allocatedWidth: 1200, loading: false, filters: { status: "all", createdOn: "all", dueDate: "all" }, sorting: undefined,
        licenseState: "licensed", licenseMessage: "", onRevalidateLicense: noop, onFiltersChange: noop, onSortChange: noop, onRefresh: noop, onOpen: noop,
        refreshDisabled: false, refreshing: false, instanceId: "dep", layout: buildLayout(poMap), ...props
      }));
    } finally { console.error = originalError; }
  }
  const planningTasks = tasks.slice(0, 5);
  const planningTree = buildHierarchy(planningTasks, { useSequence: true });
  let html = render({ tasks: planningTasks, hierarchy: planningTree, dependencies: { status: "ready", links, skipped: [] } });
  assert.ok(html.includes('class="tg-rows"') && html.includes('class="tg-deps"'));
  assert.strictEqual(count(html, 'class="tg-dep"'), 3, "three Planning Activities lines");
  assert.ok(html.includes('aria-label="555 - Store Design → 555 - Material Sourcing, Finish-to-Start"'));
  assert.ok(html.includes('role="switch"') && html.includes('aria-checked="true"') && html.includes("</span>Dependencies</button>"), "toggle is on by default");
  assert.ok(html.includes('marker-end="url(#tg-dep-arrow-dep)"'));
  assert.ok(!html.includes("tg-deps-status"), "no note when every link is drawn");
  assert.strictEqual(count(html, 'class="tg-bar '), 4, "bars are unchanged");

  // Same-day pair renders the loop route (6 segments).
  const sameDayPath = /aria-label="555 - Building Permits - renamed → 555 - Deed Reviews, Finish-to-Start"/.test(html) && /d="(M[^"]+)"[^>]*aria-label="555 - Building Permits/.exec(html)[1];
  assert.strictEqual(sameDayPath.split(/[HV]/).length - 1, 5, `same-day route loops: ${sameDayPath}`);

  // Filtered: Material Sourcing missing -> stub and note.
  html = render({ tasks: planningTasks.filter(t => t.recordId !== T.material.id), hierarchy: buildHierarchy(planningTasks.filter(t => t.recordId !== T.material.id), { useSequence: true }), dependencies: { status: "ready", links, skipped: [] } });
  assert.strictEqual(count(html, 'class="tg-dep"'), 2);
  assert.strictEqual(count(html, 'class="tg-dep-stub"'), 1);
  assert.ok(html.includes(">1 link to rows not loaded</span>"));

  // Skipped values are reported, not drawn.
  html = render({ tasks: planningTasks, hierarchy: planningTree, dependencies: { status: "ready", links, skipped: [{ id: "s", reason: "unknownType", value: "192350003" }] } });
  assert.ok(html.includes(">1 link skipped</span>") && html.includes("Skipped: 1 with unknown link type 192350003."));

  // A failed read keeps the timeline usable.
  html = render({ tasks: planningTasks, hierarchy: planningTree, dependencies: { status: "error", links: [], skipped: [], message: "Principal user is missing prvRead privilege." } });
  assert.ok(html.includes(">Dependencies unavailable</span>") && html.includes("Bars and dates are unaffected."));
  assert.strictEqual(count(html, 'class="tg-bar '), 4);
  assert.ok(html.includes('class="tg-summary"'), "summary bar still drawn");
  assert.ok(!html.includes('class="tg-deps"'));

  // Without a link source nothing dependency-related renders (existing flat and hierarchy layouts).
  const flatHtml = render({ tasks: planningTasks, layout: buildLayout(resolveFieldMap(CUSTOM_COLUMNS, "cr123_plan")) });
  assert.ok(!flatHtml.includes("tg-rows") && !flatHtml.includes("Dependencies"));
  const treeHtml = render({ tasks: planningTasks, hierarchy: planningTree, layout: buildLayout(resolveFieldMap(HIERARCHY_COLUMNS, "simetrix_gantttestitem")) });
  assert.ok(!treeHtml.includes("tg-rows") && !treeHtml.includes("tg-deps"));

  // --- Control: Project Operations scope, paging, filtering, refresh, mode and custom settings ---
  const poRows = fixture.tasks.map(t => ({ id: t.id, values: { msdyn_subject: t.name, msdyn_start: new Date(`${t.start}T08:00:00Z`), msdyn_finish: new Date(`${t.finish}T17:00:00Z`), msdyn_parenttask: t.parent ? { id: { guid: t.parent }, etn: "msdyn_projecttask" } : null, msdyn_summary: t.summary, msdyn_ismilestone: false, msdyn_displaysequence: t.sequence } }));
  const contextFor = (ds, api, extra = {}) => {
    const ctx = makeContext(ds);
    ctx.webAPI = api;
    ctx.mode.contextInfo = { entityTypeName: "msdyn_project", entityId: `{${fixture.project.toUpperCase()}}` };
    Object.entries(extra).forEach(([name, raw]) => { ctx.parameters[name] = { raw }; });
    return ctx;
  };
  {
    const api = makeWebApi(fixture.links);
    const { ds } = makeDataset({ entityType: "msdyn_projecttask", columns: PROJECT_TASK_COLUMNS, rows: poRows, hasNextPage: true });
    ds.sortedRecordIds = poRows.slice(0, 4).map(r => r.id);                    // first page: Planning, Building, Deed, Store
    const control = new TaskGantt();
    control.init(contextFor(ds, api), noop);
    let props = control.updateView(contextFor(ds, api)).props;
    assert.strictEqual(props.dependencies.status, "loading");
    await tick();
    props = control.updateView(contextFor(ds, api)).props;
    assert.strictEqual(api.calls.length, 1);
    assert.ok(api.calls[0].fetchXml.includes(`value="${fixture.project}"`), "scoped to the hosting project");
    assert.strictEqual(props.dependencies.status, "ready");
    assert.strictEqual(props.dependencies.links.length, 3, "Store Design -> Material Sourcing is read even though Material Sourcing is on a later page");

    ds.sortedRecordIds = poRows.map(r => r.id);                                // Load more
    props = control.updateView(contextFor(ds, api)).props;
    await tick();
    props = control.updateView(contextFor(ds, api)).props;
    assert.strictEqual(api.calls.length, 2, "only the new page is read");
    assert.strictEqual(props.dependencies.links.length, 4, "deduplicated across pages");

    props.onRefresh();
    assert.strictEqual(props.dependencies.links.length, 4);
    props = control.updateView(contextFor(ds, api)).props;
    await tick();
    props = control.updateView(contextFor(ds, api)).props;
    assert.strictEqual(api.calls.length, 3, "a manual refresh reads the links again");
    assert.strictEqual(props.dependencies.links.length, 4);
  }
  {
    const api = makeWebApi(fixture.links);
    const { ds } = makeDataset({ entityType: "msdyn_projecttask", columns: PROJECT_TASK_COLUMNS, rows: poRows });
    const control = new TaskGantt();
    control.init(contextFor(ds, api, { dependencyMode: "off" }), noop);
    const props = control.updateView(contextFor(ds, api, { dependencyMode: "off" })).props;
    assert.strictEqual(props.dependencies, undefined);
    await tick();
    assert.strictEqual(api.calls.length, 0, "Off reads nothing");
  }
  {
    // Without a project form or a Project column there is no scope, so nothing is read and the reason is named.
    const api = makeWebApi(fixture.links);
    const { ds } = makeDataset({ entityType: "msdyn_projecttask", columns: PROJECT_TASK_COLUMNS, rows: poRows });
    const ctx = contextFor(ds, api); delete ctx.mode.contextInfo;
    const control = new TaskGantt();
    control.init(ctx, noop);
    const props = control.updateView(ctx).props;
    assert.strictEqual(props.dependencies.status, "error");
    assert.strictEqual(props.dependencies.errorKind, "noProject");
    assert.ok(props.dependencies.message.includes("Add the Project column to this view"));
    assert.strictEqual(api.calls.length, 0);
  }
  {
    // Custom link table on the Gantt Test Item table, Finish-to-Start only.
    const linkRows = [{ simetrix_gantttestlinkid: "l1", _simetrix_predecessor_value: "c1", _simetrix_successor_value: "c2" }];
    const api = makeWebApi(linkRows);
    const { ds } = makeDataset({ entityType: "simetrix_gantttestitem", columns: HIERARCHY_COLUMNS, rows: [
      { id: "c1", values: { simetrix_name: "A", simetrix_startdate: "2026-11-23", simetrix_finishdate: "2026-11-27" } },
      { id: "c2", values: { simetrix_name: "B", simetrix_startdate: "2026-11-30", simetrix_finishdate: "2026-12-11" } }] });
    const settings = { dependencyTable: "simetrix_gantttestlink", dependencyPredecessorColumn: "simetrix_predecessor", dependencySuccessorColumn: "simetrix_successor" };
    const ctx = makeContext(ds); ctx.webAPI = api; Object.entries(settings).forEach(([k, raw]) => { ctx.parameters[k] = { raw }; });
    const control = new TaskGantt();
    control.init(ctx, noop);
    control.updateView(ctx);
    await tick();
    const props = control.updateView(ctx).props;
    assert.strictEqual(api.calls[0].table, "simetrix_gantttestlink");
    assert.ok(!api.calls[0].fetchXml.includes("msdyn_project"));
    assert.deepStrictEqual(props.dependencies.links.map(l => [l.predecessorId, l.successorId, l.type]), [["c1", "c2", "FS"]]);
  }
  {
    // A custom table without settings, and the standard Task table, get no dependency UI and no reads.
    for (const [entityType, columns] of [["cr123_plan", CUSTOM_COLUMNS], ["simetrix_gantttestitem", HIERARCHY_COLUMNS]]) {
      const api = makeWebApi([]);
      const { ds } = makeDataset({ entityType, columns, rows: [{ id: "r1", values: {} }] });
      const ctx = makeContext(ds); ctx.webAPI = api;
      const control = new TaskGantt();
      control.init(ctx, noop);
      assert.strictEqual(control.updateView(ctx).props.dependencies, undefined, entityType);
      await tick();
      assert.strictEqual(api.calls.length, 0);
    }
    // Incomplete custom settings explain what is missing instead of reading.
    const { ds } = makeDataset({ entityType: "cr123_plan", columns: CUSTOM_COLUMNS, rows: [] });
    const ctx = makeContext(ds); ctx.parameters.dependencyTable = { raw: "cr123_link" };
    const control = new TaskGantt();
    control.init(ctx, noop);
    assert.ok(control.updateView(ctx).props.dependencies.message.includes("Predecessor column, Successor column"));
  }

  // --- Multi-project views (3.6.0): each row's Project lookup scopes its links ---
  {
    // 3.5.0 diagnosis: a view spanning two projects had no single scope, so nothing was read and the misleading
    // "Dependencies need the current project" error was shown even though the Project column was in the view.
    const P = fixture.project, Q = "22222222-2222-2222-2222-222222222222", R = "33333333-3333-3333-3333-333333333333";
    const projectColumn = { name: "msdyn_project", dataType: "Lookup.Simple", displayName: "Project" };
    const ref = id => ({ id: { guid: `{${id.toUpperCase()}}` }, etn: "msdyn_project", name: id.slice(0, 4) });
    const qTasks = ["q1", "q2", "q3"].map((n, i) => ({ id: `0000000${i + 1}-0000-0000-0000-00000000000${i + 1}`, values: { msdyn_subject: `Q ${n}`, msdyn_start: new Date("2026-12-01T08:00:00Z"), msdyn_finish: new Date("2026-12-04T17:00:00Z"), msdyn_project: ref(Q) } }));
    const rTask = { id: "00000009-0000-0000-0000-000000000009", values: { msdyn_subject: "R task", msdyn_start: new Date("2026-12-07T08:00:00Z"), msdyn_finish: new Date("2026-12-08T17:00:00Z"), msdyn_project: ref(R) } };
    const qLink = { msdyn_projecttaskdependencyid: "aaaaaaaa-0000-0000-0000-000000000001", _msdyn_predecessortask_value: qTasks[0].id, _msdyn_successortask_value: qTasks[1].id, _msdyn_project_value: Q, msdyn_linktype: 192350000, msdyn_projecttaskdependencylinktype: 1 };
    // Q task 2 -> Q task 3, where task 3 is on the next page.
    const rLink = { ...qLink, msdyn_projecttaskdependencyid: "aaaaaaaa-0000-0000-0000-000000000002", _msdyn_predecessortask_value: qTasks[1].id, _msdyn_successortask_value: qTasks[2].id };
    // A row filed under a project the view does not show must never be returned by a scoped query.
    const strayLink = { ...qLink, msdyn_projecttaskdependencyid: "aaaaaaaa-0000-0000-0000-000000000003", _msdyn_project_value: "44444444-4444-4444-4444-444444444444" };
    const pRows = poRows.map(row => ({ ...row, values: { ...row.values, msdyn_project: ref(P) } }));
    const columns = [...PROJECT_TASK_COLUMNS, projectColumn];
    const api = makeWebApi([...fixture.links, qLink, rLink, strayLink]);
    const { ds } = makeDataset({ entityType: "msdyn_projecttask", columns, rows: [...pRows, ...qTasks, rTask], hasNextPage: true });
    ds.sortedRecordIds = [...pRows, qTasks[0], qTasks[1]].map(r => r.id);
    const ctx = makeContext(ds); ctx.webAPI = api;                          // a Project Tasks view, not a project form
    const control = new TaskGantt();
    control.init(ctx, noop);
    let props = control.updateView(ctx).props;
    assert.strictEqual(props.dependencies.status, "loading", "multi-project views now read links");
    await tick();
    props = control.updateView(ctx).props;
    assert.strictEqual(api.calls.length, 1, "one batch for the first 50 rows");
    assert.ok(api.calls[0].fetchXml.includes(`<condition attribute="msdyn_project" operator="in"><value>${P}</value><value>${Q}</value></condition>`), "scoped to exactly the represented projects");
    assert.ok(api.calls[0].fetchXml.includes('<condition attribute="statecode" operator="eq" value="0" />'));
    assert.deepStrictEqual(props.dependencies.links.map(l => l.id).sort(), [...fixture.links.map(l => l.msdyn_projecttaskdependencyid), qLink.msdyn_projecttaskdependencyid, rLink.msdyn_projecttaskdependencyid].sort(),
      "P and Q links are read, including Q task 2 -> Q task 3 whose successor is not loaded yet; the stray row is not");
    assert.strictEqual(props.dependencies.unscoped, undefined);

    // Q task 3 is not loaded: a stub, then Load more reads only the new tasks and the shared link is not duplicated.
    let html = render({ tasks: props.tasks, hierarchy: props.hierarchy, dependencies: props.dependencies });
    assert.strictEqual(count(html, 'class="tg-dep-stub"'), 1);
    ds.sortedRecordIds = [...pRows, ...qTasks, rTask].map(r => r.id);
    props = control.updateView(ctx).props;
    await tick();
    props = control.updateView(ctx).props;
    assert.strictEqual(api.calls.length, 2, "only the new page is read");
    assert.ok(api.calls[1].fetchXml.includes(`<condition attribute="msdyn_project" operator="in"><value>${Q}</value><value>${R}</value></condition>`), "the new page's projects only");
    assert.ok(!api.calls[1].fetchXml.includes(`<value>${pRows[0].id}</value>`), "already-read tasks are not read again");
    assert.strictEqual(props.dependencies.links.length, 6, "deduplicated across pages and projects");
    html = render({ tasks: props.tasks, hierarchy: props.hierarchy, dependencies: props.dependencies });
    assert.strictEqual(count(html, 'class="tg-dep-stub"'), 0, "the stub reconnects after Load more");
    assert.strictEqual(count(html, 'class="tg-dep"'), 6);
  }
  {
    // Rows without a Project value are not read and are counted; a view where no row has one explains why.
    const projectColumn = { name: "msdyn_project", dataType: "Lookup.Simple", displayName: "Project" };
    const rows = poRows.map((row, i) => ({ ...row, values: { ...row.values, msdyn_project: i === 0 ? null : { id: { guid: fixture.project }, etn: "msdyn_project" } } }));
    const api = makeWebApi(fixture.links);
    const { ds } = makeDataset({ entityType: "msdyn_projecttask", columns: [...PROJECT_TASK_COLUMNS, projectColumn], rows });
    const ctx = makeContext(ds); ctx.webAPI = api;
    const control = new TaskGantt();
    control.init(ctx, noop);
    control.updateView(ctx);
    await tick();
    const props = control.updateView(ctx).props;
    assert.strictEqual(props.dependencies.unscoped, 1);
    assert.ok(!api.calls[0].fetchXml.includes(`<value>${poRows[0].id}</value>`), "the task without a project is not queried");
    const html = render({ tasks: props.tasks, hierarchy: props.hierarchy, dependencies: props.dependencies });
    assert.ok(html.includes("1 task without a project"));

    const { ds: empty } = makeDataset({ entityType: "msdyn_projecttask", columns: [...PROJECT_TASK_COLUMNS, projectColumn], rows: poRows });
    const emptyCtx = makeContext(empty); emptyCtx.webAPI = api;
    const emptyControl = new TaskGantt();
    emptyControl.init(emptyCtx, noop);
    const view = emptyControl.updateView(emptyCtx).props.dependencies;
    assert.deepStrictEqual([view.status, view.errorKind], ["error", "noProject"]);
    assert.ok(view.message.startsWith("None of the loaded tasks has a Project value"));
    assert.ok(render({ tasks: planningTasks, hierarchy: planningTree, dependencies: view }).includes(">Dependencies unavailable: no project</span>"));
  }
  {
    // Missing read privilege is named, with the Dataverse text kept for support.
    const { describeReadError } = loadSource("src/dependencyLoader.ts");
    const loader = new DependencyLoader(makeWebApi([], { fail: true }), noop);
    loader.sync(PROJECT_OPERATIONS_LINKS, scoped(fixture.project, [T.store.id]));
    await tick();
    const view = loader.view();
    assert.strictEqual(view.errorKind, "access");
    assert.ok(view.message.startsWith("You do not have permission to read dependency links (msdyn_projecttaskdependency)."));
    assert.ok(view.message.includes("prvReadmsdyn_projecttaskdependency"));
    assert.ok(render({ tasks: planningTasks, hierarchy: planningTree, dependencies: view }).includes(">Dependencies unavailable: no access</span>"));
    assert.strictEqual(describeReadError({ errorCode: 2147746336, message: "Forbidden" }, "x").kind, "access", "privilege error code");
    assert.deepStrictEqual(describeReadError(new Error("Timeout"), "x"), { kind: "read", message: "Timeout" });
  }

  console.log("TaskGantt dependency tests passed.");
})().catch(error => { console.error(error); process.exit(1); });
