/* global FIXTURE, require, document, window, location, ReactDOM, HTMLInputElement, HTMLSelectElement, Event, KeyboardEvent, MouseEvent, getComputedStyle */
// Runs inside Edge against the real control, React and CSS. The simulated host owns the saved-view scope and an
// existing host filter, evaluates PCF filter expressions like the server, appends pages on loadNextPage, reports
// totalResultCount and answers link FetchXML. All network access is disabled.
(async () => {
  const results = { pass: false, checks: 0, notes: [] };
  const check = (ok, message) => { results.checks += 1; if (!ok) throw new Error(message); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  const until = async (condition, message) => { for (let i = 0; i < 400; i += 1) { if (condition()) return; await tick(); } throw new Error(`Timed out: ${message}`); };
  const shot = new URLSearchParams(location.search).get("shot");
  const USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const { TaskGantt } = require("index");

  // --- Server-style evaluation of PCF filter expressions -------------------------------------------------------
  const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const like = (value, pattern) => {
    let re = "";
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i];
      if (c === "[") { const end = pattern.indexOf("]", i + 2); re += escapeRe(pattern.slice(i + 1, end)); i = end; }
      else re += c === "%" ? ".*" : c === "_" ? "." : escapeRe(c);
    }
    return new RegExp(`^${re}$`, "is").test(String(value ?? ""));
  };
  // Day conditions are evaluated in the user's Dynamics zone (userOffset, minutes east of UTC), like Dataverse does for
  // user-local columns; Date Only strings keep their day. The portfolio data sit at noon UTC with the user on UTC.
  let userOffset = 0;
  const day = value => value instanceof Date ? new Date(value.getTime() + userOffset * 60000).toISOString().slice(0, 10) : String(value ?? "").slice(0, 10);
  const scalar = value => value && typeof value === "object" && !(value instanceof Date) ? (value.id?.guid ?? value.id) : value;
  const matches = (record, filter) => {
    if (!filter) return true;
    const results = [
      ...(filter.conditions ?? []).map(c => {
        const raw = scalar(record[c.attributeName]);
        const value = Array.isArray(c.value) ? c.value[0] : c.value;
        switch (Number(c.conditionOperator)) {
          case 0: return raw !== null && raw !== undefined && String(raw).toLowerCase() === String(value).toLowerCase();
          case 1: return raw === null || raw === undefined || String(raw).toLowerCase() !== String(value).toLowerCase();
          case 3: return raw instanceof Date ? raw < new Date(value) : raw !== null && raw !== undefined && Number(raw) < Number(value);
          case 4: return raw !== null && raw !== undefined && Number(raw) >= Number(value);
          case 8: return raw !== null && raw !== undefined && (Array.isArray(c.value) ? c.value : [c.value]).map(String).includes(String(raw));
          case 6: return like(raw, value);
          case 7: return !like(raw, value);
          case 25: return raw !== null && raw !== undefined && day(raw) === value;
          case 26: return raw !== null && raw !== undefined && day(raw) <= value;
          case 27: return raw !== null && raw !== undefined && day(raw) >= value;
          default: throw new Error(`Unsupported operator ${c.conditionOperator}`);
        }
      }),
      ...(filter.filters ?? []).map(child => matches(record, child))
    ];
    return filter.filterOperator === 1 ? results.some(Boolean) : results.every(Boolean);
  };

  // --- Simulated model-driven host -----------------------------------------------------------------------------
  function makeHost({ entityType, columns, rows, scope = () => true, hostFilter = null, links = [], choices = {}, contextInfo, searchColumn, labels = {}, parameters: extra = {}, offset, width = 1300, height = 640 }) {
    userOffset = offset ?? 0;
    const log = { setFilter: [], fetchXml: [], metadata: [] };
    let filter = hostFilter, pageSize = 25, pages = 1, matching = [], loading = false;
    const query = () => { matching = rows.filter(row => scope(row) && matches(row, filter)); };
    query();
    const records = Object.fromEntries(rows.map(row => [row.id, {
      getValue: name => row[name] === undefined ? null : row[name],
      getFormattedValue: name => {
        const value = row[name];
        if (value === null || value === undefined) return "";
        if (labels[name]) return labels[name][String(value)] ?? String(value);
        if (value instanceof Date) return value.toLocaleDateString();
        if (typeof value === "object") return value.name ?? "";
        return String(value);
      },
      getNamedReference: () => ({ id: { guid: row.id }, etn: entityType, name: row[columns[0].name] })
    }]));
    let render = () => {};
    const ds = {
      columns, records, sorting: [], get loading() { return loading; },
      get sortedRecordIds() { return matching.slice(0, pages * pageSize).map(row => row.id); },
      getTargetEntityType: () => entityType,
      paging: {
        get hasNextPage() { return matching.length > pages * pageSize; },
        get totalResultCount() { return matching.length; },
        setPageSize: size => { pageSize = size; },
        reset: () => { pages = 1; },
        loadNextPage: () => { pages += 1; request(); }
      },
      filtering: {
        getFilter: () => filter ? JSON.parse(JSON.stringify(filter)) : null,
        setFilter: next => { log.setFilter.push(JSON.parse(JSON.stringify(next))); filter = JSON.parse(JSON.stringify(next)); },
        clearFilter: () => { log.setFilter.push(null); filter = null; }
      },
      refresh: () => request(),
      openDatasetItem: () => {}
    };
    function request() { loading = true; render(); setTimeout(() => { query(); loading = false; render(); }, 20); }
    const parameters = { tasks: ds, licenseKey: { raw: "" }, ...(searchColumn ? { searchColumn: { raw: searchColumn } } : {}), ...Object.fromEntries(Object.entries(extra).map(([name, raw]) => [name, { raw }])) };
    const context = {
      parameters,
      mode: { allocatedWidth: width, allocatedHeight: height, trackContainerResize() {}, ...(contextInfo ? { contextInfo } : {}) },
      factory: { requestRender: () => render() },
      page: { getClientUrl: () => "https://contoso.crm4.dynamics.com" },
      userSettings: { userId: USER, ...(offset === undefined ? {} : { getTimeZoneOffsetMinutes: () => offset }) },
      // Arrays are Web API-shaped Options; objects are the model-driven host shape { "0": { text, value } } verified live.
      utils: { getEntityMetadata: async (table, [name]) => { log.metadata.push(name); return { Attributes: { get: key => key === name && choices[name] ? { OptionSet: Array.isArray(choices[name]) ? { Options: choices[name] } : choices[name] } : undefined } }; } },
      webAPI: {
        retrieveMultipleRecords: async (table, options) => {
          const fetchXml = decodeURIComponent(options.replace("?fetchXml=", ""));
          log.fetchXml.push(fetchXml);
          const values = block => new Set([...block.matchAll(/<value>([^<]+)<\/value>/g)].map(m => m[1]));
          const eq = /attribute="msdyn_project" operator="eq" value="([^"]+)"/.exec(fetchXml);
          const inList = /<condition attribute="msdyn_project" operator="in">(.*?)<\/condition>/.exec(fetchXml);
          const projects = eq ? new Set([eq[1]]) : inList ? values(inList[1]) : undefined;
          const ends = [...fetchXml.matchAll(/<condition attribute="([^"]+)" operator="in">(.*?)<\/condition>/g)].filter(m => m[1] !== "msdyn_project");
          const ids = values(ends[0][2]);
          return { entities: links.filter(l => (!projects || projects.has(l._msdyn_project_value)) && (ids.has(l[`_${ends[0][1]}_value`]) || ids.has(l[`_${ends[1][1]}_value`]))) };
        }
      }
    };
    return { ds, context, log, width, height, setRender: fn => { render = fn; }, matchingCount: () => matching.length };
  }

  // Column metadata for column security: every column is unsecured and searchable.
  window.fetch = async url => {
    if (String(url).includes("/EntityDefinitions(")) {
      const table = /LogicalName='([^']+)'/.exec(String(url))[1];
      const names = { msdyn_projecttask: ["msdyn_subject", "msdyn_start", "msdyn_finish", "msdyn_parenttask", "msdyn_summary", "msdyn_ismilestone", "msdyn_displaysequence", "msdyn_project", "msdyn_scheduleperformance"],
        task: ["subject", "scheduledstart", "scheduledend", "ownerid", "statecode", "statuscode", "createdon"], cr123_plan: ["cr123_name", "cr123_plannedstart", "cr123_plannedfinish"] }[table];
      return { ok: true, json: async () => ({ value: names.map(name => ({ LogicalName: name, MetadataId: `m-${name}`, IsSecured: false, IsValidForAdvancedFind: { Value: true } })) }) };
    }
    throw new TypeError("Network access is disabled in this test.");
  };

  // Mounts the real control into the host element and re-renders whenever the host or the control asks.
  let mounted;
  async function mount(host) {
    const element = document.getElementById("host");
    element.style.width = `${host.width}px`;
    element.style.height = `${host.height}px`;
    mounted?.setRender(() => {});                           // late answers for the previous host render nothing
    mounted = host;
    ReactDOM.unmountComponentAtNode(element);
    const control = new TaskGantt();
    control.init(host.context, () => {});
    control.licenseState = "licensed";
    control.ensureLicenseValidation = () => {};
    let scheduled = false;
    const render = () => { if (scheduled) return; scheduled = true; setTimeout(() => { scheduled = false; ReactDOM.render(control.updateView(host.context), element); }, 0); };
    host.setRender(render);
    render();
    await until(() => element.querySelector(".tg-toolbar"), "control rendered");
    return element;
  }
  const $ = (root, selector) => root.querySelector(selector);
  const $$ = (root, selector) => Array.from(root.querySelectorAll(selector));
  const text = (root, selector) => ($(root, selector)?.textContent ?? "").trim();
  const setValue = (el, value) => {
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const button = (root, label) => $$(root, "button").find(b => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
  const settled = async (root, host, message) => {
    await until(() => !host.ds.loading && !$(root, ".tg-count.is-updating") && !$(root, ".tg-deps-status")?.textContent.includes("Loading"), message);
    await tick(); await tick();
  };
  const rowNames = root => $$(root, ".tg-row .tg-link").map(b => b.textContent);
  const count = root => text(root, ".tg-count");
  const stop = name => shot === name;

  try {
    // ============ Multi-project Project Tasks view (two projects, hierarchy, links, saved-view scope) ============
    const P1 = "11111111-1111-1111-1111-111111111111", P2 = "22222222-2222-2222-2222-222222222222";
    const at = (d, h = 12) => new Date(`2026-${d}T${String(h).padStart(2, "0")}:00:00Z`);
    const tasks = [];
    const addProject = (project, code, count, inactive) => {
      const parentId = `${code}000000-0000-0000-0000-000000000000`;
      tasks.push({ id: parentId, msdyn_subject: `${code === "a" ? "Alpha" : "Beta"} plan`, msdyn_project: { id: { guid: project }, etn: "msdyn_project", name: code === "a" ? "Alpha" : "Beta" },
        msdyn_start: at("12-01"), msdyn_finish: at("12-31"), msdyn_parenttask: null, msdyn_summary: true, msdyn_ismilestone: false, msdyn_displaysequence: 1, statecode: 0, msdyn_scheduleperformance: 192350000 });
      for (let i = 1; i <= count; i += 1) {
        const day = String(Math.min(28, i)).padStart(2, "0");
        tasks.push({ id: `${code}${String(i).padStart(7, "0")}-0000-0000-0000-000000000000`, msdyn_subject: `${code === "a" ? "Alpha" : "Beta"} ${i % 3 === 0 ? "Build" : "Design"} ${i}`,
          msdyn_project: { id: { guid: project }, etn: "msdyn_project", name: code === "a" ? "Alpha" : "Beta" }, msdyn_start: at(`12-${day}`), msdyn_finish: at(`12-${String(Math.min(30, i + 2)).padStart(2, "0")}`),
          msdyn_parenttask: { id: { guid: parentId }, etn: "msdyn_projecttask", name: "plan" }, msdyn_summary: false, msdyn_ismilestone: false, msdyn_displaysequence: i + 1,
          statecode: inactive.includes(i) ? 1 : 0, msdyn_scheduleperformance: i % 4 === 0 ? 192350002 : 192350000 });
      }
    };
    addProject(P1, "a", 30, [29, 30]);       // 29 and 30 are inactive: outside the saved view
    addProject(P2, "b", 32, []);
    // An archived row that the host filter (set through Edit filters before the Gantt touched anything) excludes.
    tasks.push({ ...tasks[5], id: "c0000001-0000-0000-0000-000000000000", msdyn_subject: "Archive Alpha Build 99" });
    const link = (id, from, to, project) => ({ msdyn_projecttaskdependencyid: `d${String(id).padStart(7, "0")}-0000-0000-0000-000000000000`, _msdyn_predecessortask_value: from, _msdyn_successortask_value: to,
      "_msdyn_predecessortask_value@OData.Community.Display.V1.FormattedValue": tasks.find(t => t.id === from).msdyn_subject, "_msdyn_successortask_value@OData.Community.Display.V1.FormattedValue": tasks.find(t => t.id === to).msdyn_subject,
      _msdyn_project_value: project, msdyn_linktype: 192350000, msdyn_projecttaskdependencylinktype: 1, statecode: 0 });
    const id = (code, i) => `${code}${String(i).padStart(7, "0")}-0000-0000-0000-000000000000`;
    const links = [link(1, id("a", 1), id("a", 2), P1), link(2, id("a", 2), id("a", 3), P1), link(3, id("a", 3), id("a", 6), P1),
      link(4, id("b", 1), id("b", 2), P2), link(5, id("b", 3), id("b", 6), P2), link(6, id("b", 17), id("b", 25), P2)];   // b25 is on page 2
    const poColumns = [
      { name: "msdyn_subject", alias: "subject", dataType: "SingleLine.Text", displayName: "Project Task Name" },
      { name: "msdyn_start", alias: "scheduledstart", dataType: "DateAndTime.DateAndTime", displayName: "Start" },
      { name: "msdyn_finish", alias: "scheduledend", dataType: "DateAndTime.DateAndTime", displayName: "Finish" },
      { name: "msdyn_parenttask", dataType: "Lookup.Simple", displayName: "Parent Task" },
      { name: "msdyn_summary", dataType: "TwoOptions", displayName: "Summary" },
      { name: "msdyn_ismilestone", dataType: "TwoOptions", displayName: "Milestone" },
      { name: "msdyn_displaysequence", dataType: "Decimal", displayName: "Display Sequence" },
      { name: "msdyn_project", dataType: "Lookup.Simple", displayName: "Project" },
      { name: "msdyn_scheduleperformance", dataType: "OptionSet", displayName: "Schedule Performance" }];
    const performance = [{ Value: 192350000, Label: { UserLocalizedLabel: { Label: "On Time" } } }, { Value: 192350002, Label: { UserLocalizedLabel: { Label: "Behind" } } }];
    const hostFilter = { filterOperator: 0, conditions: [{ attributeName: "msdyn_subject", conditionOperator: 7, value: "Archive%" }] };
    const po = makeHost({ entityType: "msdyn_projecttask", columns: poColumns, rows: tasks, scope: row => row.statecode === 0, hostFilter, links,
      choices: { msdyn_scheduleperformance: performance }, searchColumn: "msdyn_subject", labels: { msdyn_scheduleperformance: { 192350000: "On Time", 192350002: "Behind" } } });
    let root = await mount(po);
    await settled(root, po, "portfolio loaded");
    const allActive = 31 + 33 - 2;                          // two projects with parents, minus two inactive tasks
    check(count(root) === `50 loaded · ${allActive} matching records`, `initial count: ${count(root)}`);
    check(rowNames(root).length === 50 && !rowNames(root).some(name => name.startsWith("Archive")), "50 rows, host-filtered row excluded");
    check(po.log.fetchXml.length === 1 && po.log.fetchXml[0].includes(`<condition attribute="msdyn_project" operator="in"><value>${P1}</value><value>${P2}</value></condition>`), "one link read scoped to both projects");
    check(!text(root, ".tg-actions").includes("Dependencies unavailable"), "multi-project view no longer reports Dependencies unavailable");
    check($(root, '.tg-deps-toggle[role="switch"][aria-checked="true"]'), "dependency switch is on");
    check(getComputedStyle($(root, ".tg-summary")).backgroundColor === "rgb(50, 49, 48)" && $$(root, ".tg-bar.neutral").length > 0, "summary bars stay dark and distinct from task bars");
    check(text(root, ".tg-legend-off") === "Deadline colours off: completion not configured", "Project Operations: no completion semantics are assumed");
    check($$(root, "path.tg-dep").length === 5 && $$(root, ".tg-dep-stub").length === 1, `5 lines and 1 stub (b17 -> b25 on page 2): ${$$(root, "path.tg-dep").length}/${$$(root, ".tg-dep-stub").length}`);
    check(text(root, ".tg-deps-status") === "1 link to rows not loaded", `dependency note: ${text(root, ".tg-deps-status")}`);
    check($(root, 'input[type="search"]') && text(root, ".tg-search label span") === "Search Project Task Name", "labelled search box");
    results.notes.push(`Multi-project: ${count(root)}; link query scoped with msdyn_project in (2 projects)`);
    if (stop("portfolio")) { results.pass = true; return; }

    // Collapse Alpha: visible rows drop, the matching total does not, Alpha-internal links are hidden.
    $(root, 'button[aria-label="Collapse Alpha plan"]').click();
    await until(() => count(root).includes("visible"), "visible count after collapse");
    check(count(root) === `50 loaded · ${allActive} matching records · 22 visible`, `collapsed count: ${count(root)}`);
    check($$(root, ".tg-row").length === 22, "22 rows rendered");
    check($$(root, "path.tg-dep").length === 2 && $$(root, ".tg-dep-stub").length === 1, "Alpha links hidden inside the collapsed group; Beta lines and stub stay");
    if (stop("collapsed")) { results.pass = true; return; }
    $(root, 'button[aria-label="Expand Alpha plan"]').click();
    await until(() => !count(root).includes("visible"), "expanded");

    // Search all pages: "Build" matches tasks on both pages; returns to page 1 and keeps the host filter.
    const search = $(root, 'input[type="search"]');
    setValue(search, "Build");
    button(root, "Search Project Task Name").click();
    await settled(root, po, "search applied");
    const builds = tasks.filter(t => t.statecode === 0 && /Build/.test(t.msdyn_subject) && !t.msdyn_subject.startsWith("Archive")).length;
    check(count(root) === `${builds} loaded · ${builds} matching records`, `search count: ${count(root)} (expected ${builds})`);
    check(rowNames(root).every(name => name.includes("Build")) && rowNames(root).includes("Beta Build 30"), "matches from every page, Beta Build 30 included");
    const written = po.log.setFilter[po.log.setFilter.length - 1];
    check(JSON.stringify(written.filters) === JSON.stringify([hostFilter]) && written.conditions[0].value === "%Build%", "Contains condition ANDed with the unchanged host filter");
    check(text(root, ".tg-waiting") === `${builds} without loaded parent`, "children whose parent is filtered out stay top level and are counted");
    check($$(root, ".tg-chip").length === 1 && text(root, ".tg-chip") .startsWith("Project Task Name contains “Build”"), "search chip");
    check($$(root, ".tg-col-task .tg-filter-mark").length === 1, "title header marked as filtered");
    // a3 -> a6 is a Build-Build pair? a3 is Build, a6 is Build: drawn. b3 -> b6 likewise. Links to non-matching ends become stubs.
    check($$(root, "path.tg-dep").length === 2, `lines between matching rows: ${$$(root, "path.tg-dep").length}`);
    check($$(root, ".tg-dep-stub").length === 1, `stub for a2 -> a3 (a2 filtered out): ${$$(root, ".tg-dep-stub").length}`);

    // Add a choice filter (raw value, localized label) and a date filter.
    button(root, "Filters").click();
    await until(() => $(root, ".tg-filter-editor"), "filter editor");
    const editor = () => $(root, ".tg-filter-editor");
    setValue($(editor(), "select"), "msdyn_scheduleperformance");
    await until(() => $$(editor(), "select")[2]?.options.length === 3, "choice options from metadata");
    check(Array.from($$(editor(), "select")[2].options).map(o => `${o.value}:${o.text}`).join("|") === ":Select…|192350000:On Time|192350002:Behind", "metadata options with raw values");
    setValue($$(editor(), "select")[2], "192350002");
    button(root, "Apply").click();
    await settled(root, po, "choice filter applied");
    const behind = tasks.filter(t => t.statecode === 0 && /Build/.test(t.msdyn_subject) && !t.msdyn_subject.startsWith("Archive") && t.msdyn_scheduleperformance === 192350002).length;
    check(count(root) === `${behind} loaded · ${behind} matching records`, `choice filter count: ${count(root)} (expected ${behind})`);
    check($$(root, ".tg-chip").map(c => c.textContent).some(t => t.startsWith("Schedule Performance is Behind")), "choice chip shows the label");
    check(po.log.setFilter[po.log.setFilter.length - 1].conditions.some(c => c.attributeName === "msdyn_scheduleperformance" && c.value === "192350002"), "raw value sent");

    button(root, "Filters (1)").click();
    await until(() => editor(), "filter editor reopened");
    setValue($(editor(), "select"), "msdyn_finish");
    await until(() => $$(editor(), "select")[1].options.length === 3, "date operators");
    setValue($$(editor(), "select")[1], "before");
    setValue($(editor(), 'input[type="date"]'), "2026-12-20");
    button(root, "Apply").click();
    await settled(root, po, "date filter applied");
    const beforeTwentieth = tasks.filter(t => t.statecode === 0 && /Build/.test(t.msdyn_subject) && !t.msdyn_subject.startsWith("Archive") && t.msdyn_scheduleperformance === 192350002 && day(t.msdyn_finish) <= "2026-12-19").length;
    check(count(root) === `${beforeTwentieth} loaded · ${beforeTwentieth} matching records`, `date filter count: ${count(root)} (expected ${beforeTwentieth})`);
    check($$(root, ".tg-chip").length === 3 && button(root, "Clear all filters"), "three chips and Clear all filters");
    check($$(root, ".tg-col-due .tg-filter-mark").length === 1, "Finish header marked");
    results.notes.push(`Search + choice + date: ${count(root)}`);
    if (stop("filtered")) { results.pass = true; return; }

    // Clear one filter, then all: back to the full view with the host filter intact, page 1.
    button(root, "Clear filter: Schedule Performance is Behind").click();
    await settled(root, po, "one filter cleared");
    check($$(root, ".tg-chip").length === 2, "two chips left");
    button(root, "Clear all filters").click();
    await settled(root, po, "all cleared");
    check(count(root) === `50 loaded · ${allActive} matching records`, `cleared count: ${count(root)}`);
    check(JSON.stringify(po.log.setFilter[po.log.setFilter.length - 1]) === JSON.stringify(hostFilter), "only the host filter is written back");
    check(!$(root, ".tg-chip") && !button(root, "Clear all filters"), "no chips after clearing");
    check($$(root, "path.tg-dep").length === 5 && $$(root, ".tg-dep-stub").length === 1, "lines and stub restored after clearing");

    // Load more: the page-2 end reconnects; only new tasks are read; the count follows.
    const readsBefore = po.log.fetchXml.length;
    $(root, ".tg-more").click();
    await settled(root, po, "load more");
    check(count(root) === `${allActive} loaded · ${allActive} matching records`, `after Load more: ${count(root)}`);
    check($$(root, "path.tg-dep").length === 6 && $$(root, ".tg-dep-stub").length === 0, "stub reconnects after Load more");
    check(po.log.fetchXml.length === readsBefore + 1 && po.log.fetchXml[readsBefore].includes(`operator="eq" value="${P2}"`), "only the new Beta tasks are read");
    check(!$(root, ".tg-more"), "no further page");
    results.notes.push(`Load more: ${count(root)}, ${$$(root, "path.tg-dep").length} lines, ${po.log.fetchXml.length} link reads in total`);

    // ============ Single-project view on a project form: the 3.5.0 eq scope ============
    const alphaOnly = makeHost({ entityType: "msdyn_projecttask", columns: poColumns.filter(c => c.name !== "msdyn_project"), rows: tasks.filter(t => t.msdyn_project.id.guid === P1 && !t.msdyn_subject.startsWith("Archive")), scope: row => row.statecode === 0,
      links, contextInfo: { entityTypeName: "msdyn_project", entityId: `{${P1.toUpperCase()}}` } });
    root = await mount(alphaOnly);
    await settled(root, alphaOnly, "single project loaded");
    check(alphaOnly.log.fetchXml[0].includes(`<condition attribute="msdyn_project" operator="eq" value="${P1}" />`), "project form keeps the eq scope");
    check($$(root, "path.tg-dep").length === 3 && count(root) === "29 loaded · 29 matching records", `single project: ${count(root)}`);
    check(!$(root, 'input[type="search"]'), "no search box without a search column");

    // ============ Multi-project view without the Project column: the reason is explained ============
    const noProject = makeHost({ entityType: "msdyn_projecttask", columns: poColumns.filter(c => c.name !== "msdyn_project"), rows: tasks, scope: row => row.statecode === 0, links });
    root = await mount(noProject);
    await settled(root, noProject, "view without Project column");
    check(text(root, ".tg-deps-status") === "Dependencies unavailable: no project", `no-project note: ${text(root, ".tg-deps-status")}`);
    check($(root, ".tg-deps-status").title.startsWith("Dependency lines need each task's project. Add the Project column to this view"), "explanation in the note");
    check(noProject.log.fetchXml.length === 0, "nothing read without project context");

    // ============ Standard Tasks (flat, page size 10): Status choice by raw value, localized labels ============
    const taskRows = Array.from({ length: 23 }, (_, i) => ({ id: `t${String(i).padStart(2, "0")}`, subject: `${i % 2 ? "Call" : "Visit"} customer ${i}`, ownerid: { id: { guid: USER }, name: "K. R." },
      statecode: i % 5 === 0 ? 1 : 0, scheduledstart: at(`12-${String(1 + (i % 20)).padStart(2, "0")}`), scheduledend: at(`12-${String(3 + (i % 20)).padStart(2, "0")}`), createdon: at("11-01") }));
    const taskColumns = [
      { name: "subject", alias: "subject", dataType: "SingleLine.Text", displayName: "Subject" },
      { name: "scheduledend", alias: "scheduledend", dataType: "DateAndTime.DateAndTime", displayName: "Due Date" },
      { name: "ownerid", alias: "ownerid", dataType: "Lookup.Owner", displayName: "Owner" },
      { name: "statecode", alias: "statecode", dataType: "OptionSet", displayName: "Activity Status" },
      { name: "scheduledstart", alias: "scheduledstart", dataType: "DateAndTime.DateAndTime", displayName: "Start Date" },
      { name: "createdon", alias: "createdon", dataType: "DateAndTime.DateAndTime", displayName: "Created On" }];
    // German labels: completion must come from the raw value, never from the label text.
    const stateOptions = { 0: { text: "Offen", value: 0 }, 1: { text: "Erledigt", value: 1 }, 2: { text: "Abgebrochen", value: 2 } };
    const taskHost = makeHost({ entityType: "task", columns: taskColumns, rows: taskRows, choices: { statecode: stateOptions }, searchColumn: "subject", labels: { statecode: { 0: "Offen", 1: "Erledigt", 2: "Abgebrochen" } } });
    root = await mount(taskHost);
    await settled(root, taskHost, "tasks loaded");
    check(count(root) === "10 loaded · 23 matching records", `tasks count: ${count(root)}`);
    check(!$(root, ".tg-deps-toggle"), "standard Tasks have no dependency UI");
    button(root, "Filters").click();
    await until(() => $(root, ".tg-filter-editor"), "tasks filter editor");
    setValue($(editor(), "select"), "statecode");
    await until(() => $$(editor(), "select")[2]?.options.length === 4, "state options");
    check(Array.from($$(editor(), "select")[2].options).map(o => `${o.value}:${o.text}`).join("|") === ":Select…|0:Offen|1:Erledigt|2:Abgebrochen", "host-shaped metadata shows localized labels (3.6.0 showed 0, 1, 2)");
    setValue($$(editor(), "select")[2], "1");
    button(root, "Apply").click();
    await settled(root, taskHost, "state filter applied");
    check(count(root) === "5 loaded · 5 matching records" && text(root, ".tg-chip").startsWith("Activity Status is Erledigt"), `Erledigt: ${count(root)}`);
    check(!editor(), "popover closed after Apply");
    check($$(root, ".tg-status").every(s => s.textContent === "Erledigt" && s.classList.contains("completed")), "rows are completed by raw value and show the localized label");
    check($$(root, ".tg-bar").every(bar => bar.classList.contains("completed")), "completed bars");
    if (stop("tasks")) { results.pass = true; return; }
    button(root, "Clear all filters").click();
    await settled(root, taskHost, "tasks cleared");
    $(root, ".tg-more").click();
    await settled(root, taskHost, "tasks load more");
    check(count(root) === "20 loaded · 23 matching records", `tasks after Load more: ${count(root)}`);

    // ============ Custom table, Date Only: On ============
    const planRows = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, cr123_name: `Step ${i}`, cr123_plannedstart: `2026-12-0${i + 1}`, cr123_plannedfinish: `2026-12-0${i + 2}` }));
    const planHost = makeHost({ entityType: "cr123_plan", rows: planRows, columns: [
      { name: "cr123_name", alias: "subject", dataType: "SingleLine.Text", displayName: "Name" },
      { name: "cr123_plannedstart", alias: "scheduledstart", dataType: "DateAndTime.DateOnly", displayName: "Planned Start" },
      { name: "cr123_plannedfinish", alias: "scheduledend", dataType: "DateAndTime.DateOnly", displayName: "Planned Finish" }] });
    root = await mount(planHost);
    await settled(root, planHost, "plan loaded");
    button(root, "Filters").click();
    await until(() => $(root, ".tg-filter-editor"), "plan filter editor");
    setValue($(editor(), "select"), "cr123_plannedstart");
    await until(() => $(editor(), 'input[type="date"]'), "date input");
    setValue($(editor(), 'input[type="date"]'), "2026-12-03");
    button(root, "Apply").click();
    await settled(root, planHost, "date only On");
    check(count(root) === "1 loaded · 1 matching record" && rowNames(root)[0] === "Step 2", `Date Only On: ${count(root)} ${rowNames(root)}`);
    const editorError = async () => {
      button(root, "Filters (1)").click();
      await until(() => editor(), "editor");
      setValue($(editor(), "select"), "cr123_name");
      await until(() => $(editor(), 'input[type="text"]'), "text input");
      button(root, "Apply").click();
      await until(() => $(root, ".tg-filter-error"), "validation");
      return text(root, ".tg-filter-error");
    };
    check(await editorError() === "Enter a value.", "empty text value is rejected");

    // ============ 3.7.0 deadline colours: Status Reason with configured raw values, Dynamics user on UTC+14 ============
    // The browser runs in its own zone; the user's Dynamics zone (UTC+14) decides today and every Finish day.
    const OFFSET = 840;
    const userNow = new Date(Date.now() + OFFSET * 60000);
    const userDay = k => new Date(Date.UTC(userNow.getUTCFullYear(), userNow.getUTCMonth(), userNow.getUTCDate() + k, 12) - OFFSET * 60000);
    const reasonLabels = { 2: "Nicht begonnen", 3: "In Bearbeitung", 5: "Abgeschlossen", 6: "Abgebrochen" };
    const deadlineRows = [["far", "Kick-off", 6, 3], ["two", "Permits", 2, 3], ["one", "Survey", 1, 2], ["today", "Inspection", 0, 3], ["late1", "Site review", -1, 3],
      ["late3", "Deed review", -3, 3], ["done", "Design", -3, 5], ["dropped", "Old scope", -3, 6]]
      .map(([rowId, subject, finish, statuscode]) => ({ id: rowId, subject, statuscode, ownerid: { id: { guid: USER }, name: "K. R." }, scheduledstart: userDay(finish - 2), scheduledend: userDay(finish), createdon: userDay(-20) }));
    const reasonColumns = taskColumns.map(c => c.name === "statecode" ? { ...c, name: "statuscode", displayName: "Status Reason" } : c);
    const reasonChoices = { statuscode: Object.fromEntries(Object.entries(reasonLabels).map(([value, label]) => [value, { text: label, value: Number(value) }])) };
    const deadlineHost = (extraRows = [], size = {}) => makeHost({ entityType: "task", columns: reasonColumns, rows: [...deadlineRows, ...extraRows], choices: reasonChoices, labels: { statuscode: reasonLabels },
      parameters: { completedStatusValues: "5", canceledStatusValues: "6" }, offset: OFFSET, searchColumn: "subject", ...size });
    const dl = deadlineHost();
    root = await mount(dl);
    await settled(root, dl, "deadline rows loaded");
    const barOf = name => $$(root, ".tg-bar").find(bar => bar.getAttribute("aria-label").startsWith(`${name}:`));
    const tones = deadlineRows.map(row => Array.from(barOf(row.subject).classList).find(c => c !== "tg-bar"));
    check(tones.join(",") === "scheduled,approaching,near,imminent,overdue,overdue,completed,canceled", `bar tones: ${tones}`);
    const colour = name => getComputedStyle(barOf(name)).backgroundColor;
    check(colour("Kick-off") === "rgb(15, 108, 189)" && colour("Permits") === "rgb(253, 227, 0)" && colour("Survey") === "rgb(247, 99, 12)" && colour("Inspection") === "rgb(202, 80, 16)",
      `blue, yellow, orange, dark orange: ${["Kick-off", "Permits", "Survey", "Inspection"].map(colour)}`);
    check(getComputedStyle(barOf("Site review")).backgroundImage.includes("rgb(209, 52, 56)"), "overdue is red");
    check(colour("Design") === "rgb(16, 124, 16)" && colour("Old scope") === "rgb(161, 159, 157)", "completed green, canceled grey");
    check(barOf("Inspection").getAttribute("aria-label").endsWith(`Due today — due ${barOf("Inspection").getAttribute("aria-label").split("due ").pop()}`), "due today is not overdue");
    check(text(root, '.tg-calendar [aria-current="date"] b') === String(userNow.getUTCDate()), `today is the user's day (UTC+14): ${text(root, '.tg-calendar [aria-current="date"] b')}`);
    check($$(root, ".tg-status").map(s => s.textContent).join("|") === deadlineRows.map(r => reasonLabels[r.statuscode]).join("|"), "Status Reason labels shown as returned");
    // Overdue icon: two, focusable, with the tooltip on keyboard focus and on hover.
    const icons = $$(root, ".tg-urgency.overdue");
    check(icons.length === 2 && icons.every(icon => icon.tabIndex === 0), "red warning icon beside the two overdue names only");
    check(icons[0].closest(".tg-task-title").textContent === "Site review" && icons[0].getAttribute("aria-label") === "Overdue by 1 day", "singular, named for screen readers");
    icons[0].focus();
    await until(() => $(root, ".tg-tip"), "tooltip on focus");
    const rootRect = $(root, ".tg").getBoundingClientRect();
    const tipRect = $(root, ".tg-tip").getBoundingClientRect();
    check(text(root, ".tg-tip") === "Overdue by 1 day" && tipRect.left >= rootRect.left && tipRect.right <= rootRect.right, `focus tooltip: ${text(root, ".tg-tip")}`);
    icons[0].blur();
    await until(() => !$(root, ".tg-tip"), "tooltip hidden on blur");
    // React 16 derives mouseenter from the mouseout of the element the pointer leaves.
    document.body.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: icons[1] }));
    await until(() => $(root, ".tg-tip"), "tooltip on hover");
    check(text(root, ".tg-tip") === "Overdue by 3 days", `hover tooltip: ${text(root, ".tg-tip")}`);
    icons[1].dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    await until(() => !$(root, ".tg-tip"), "tooltip hidden on leave");
    // The overdue filter uses the same rule on the server: Finish on or before the user's yesterday, not Completed or Canceled.
    button(root, "Overdue").click();
    await settled(root, dl, "overdue filter");
    check(rowNames(root).join("|") === "Site review|Deed review" && count(root) === "2 loaded · 2 matching records", `overdue filter: ${rowNames(root)} ${count(root)}`);
    const overdueConditions = dl.log.setFilter[dl.log.setFilter.length - 1].conditions;
    check(JSON.stringify(overdueConditions) === JSON.stringify([{ attributeName: "statuscode", conditionOperator: 1, value: "5" }, { attributeName: "statuscode", conditionOperator: 1, value: "6" },
      { attributeName: "scheduledend", conditionOperator: 26, value: new Date(userDay(-1).getTime() + OFFSET * 60000).toISOString().slice(0, 10) }]), `overdue conditions: ${JSON.stringify(overdueConditions)}`);
    button(root, "Active").click();
    await settled(root, dl, "active filter");
    check(count(root) === "6 loaded · 6 matching records", `active: ${count(root)}`);
    button(root, "All").click();
    await settled(root, dl, "all");
    // Status Reason options in Filters show localized labels and filter by raw value.
    button(root, "Filters").click();
    await until(() => $(root, ".tg-popover"), "popover");
    setValue($(root, ".tg-popover select"), "statuscode");
    await until(() => $$(root, ".tg-popover select")[2]?.options.length === 5, "Status Reason options");
    check(Array.from($$(root, ".tg-popover select")[2].options).slice(1).map(o => `${o.value}:${o.text}`).join("|") === "2:Nicht begonnen|3:In Bearbeitung|5:Abgeschlossen|6:Abgebrochen", "Status Reason labels from metadata");
    button(root, "Cancel").click();
    // Full page at 100% zoom: count, legend and Load more stay on screen.
    const footer = $(root, ".tg-footer");
    check(footer.getBoundingClientRect().bottom <= window.innerHeight && $(root, ".tg-count").getBoundingClientRect().top >= 0, "footer and count visible at 100% zoom");
    check(["Scheduled", "Due soon", "Overdue", "Completed", "Canceled"].every(label => footer.textContent.includes(label)), "colour legend");
    results.notes.push(`Deadlines (user UTC+14, browser ${Intl.DateTimeFormat().resolvedOptions().timeZone}): ${tones.join(", ")}`);
    if (stop("deadlines")) { results.pass = true; return; }

    // ============ Narrow form subgrid (560 x 420): toolbar wraps, footer and count stay visible ============
    const extra = Array.from({ length: 6 }, (_, i) => ({ ...deadlineRows[0], id: `x${i}`, subject: `Follow-up ${i + 1}`, scheduledstart: userDay(3 + i), scheduledend: userDay(5 + i) }));
    const sub = deadlineHost(extra, { width: 560, height: 420 });
    root = await mount(sub);
    await settled(root, sub, "subgrid loaded");
    const host = document.getElementById("host").getBoundingClientRect();
    const inside = el => { const r = el.getBoundingClientRect(); return r.left >= host.left - 1 && r.right <= host.right + 1 && r.top >= host.top - 1 && r.bottom <= host.bottom + 1; };
    check($(root, ".tg").classList.contains("tg-compact"), "compact layout in the subgrid");
    check($(root, ".tg-toolbar").scrollWidth <= $(root, ".tg-toolbar").clientWidth + 1 && $(root, ".tg-footer").scrollWidth <= $(root, ".tg-footer").clientWidth + 1, "no horizontal overflow in toolbar or footer");
    check(inside($(root, ".tg-count")) && inside($(root, ".tg-more")) && inside($(root, ".tg-legend")), "count, Load more and legend inside the subgrid");
    check(count(root) === "10 loaded · 14 matching records", `subgrid count: ${count(root)}`);
    const scroller = $(root, ".tg-scroll");
    check(scroller.clientHeight >= 120, `rows keep room to scroll: ${scroller.clientHeight}px`);
    // Today button scrolls the timeline back to today.
    scroller.scrollTo({ left: 0, behavior: "instant" });     // the grid scrolls smoothly; jump away from today first
    await until(() => scroller.scrollLeft === 0, "scrolled away from today");
    button(root, "Today").click();
    await until(() => scroller.scrollLeft > 0, "Today scrolls the timeline");
    // Today lands in the visible timeline, right of the frozen columns.
    const frozenRight = () => $(root, ".tg-head .tg-col-due").getBoundingClientRect().right;
    const todayInView = () => { const m = $(root, ".tg-calendar .tg-today").getBoundingClientRect(); return m.left >= frozenRight() && m.right <= scroller.getBoundingClientRect().right; };
    await until(todayInView, "today is in view after Today");
    check(todayInView(), "today is in view");
    // Filters popover: opens inside the control, focus moves in, Escape closes and returns focus.
    const filtersButton = button(root, "Filters");
    filtersButton.click();
    await until(() => $(root, ".tg-popover"), "subgrid popover");
    check(inside($(root, ".tg-popover")) || $(root, ".tg-popover").getBoundingClientRect().right <= host.right + 1, "popover stays within the subgrid width");
    await until(() => $(root, ".tg-popover").contains(document.activeElement), `focus moves into the popover (now on ${document.activeElement?.tagName}.${document.activeElement?.className})`);
    check(document.activeElement === $(root, ".tg-popover select"), "focus starts on the Column field");
    const pop = $(root, ".tg-popover").getBoundingClientRect();
    const topmost = document.elementFromPoint(pop.left + pop.width / 2, pop.bottom - 12);
    check($(root, ".tg-popover").contains(topmost), `popover is drawn above the grid header and rows (top element: ${topmost?.className})`);
    check(filtersButton.getAttribute("aria-expanded") === "true" && $(root, ".tg-popover").getAttribute("role") === "dialog", "popover is announced");
    if (stop("popover")) { results.pass = true; return; }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => !$(root, ".tg-popover"), "Escape closes the popover");
    check(document.activeElement === button(root, "Filters"), "focus returns to Filters");
    // Keyboard: the overdue icon is reachable and shows its tooltip in the subgrid too.
    $(root, ".tg-urgency.overdue").focus();
    // Focus scrolls the icon into view; the tooltip follows it and stays inside the subgrid.
    check(!$(root, ".tg-tip"), "no tooltip while the focused icon is scrolled out of the visible rows");
    // Headless virtual time neither advances the grid's smooth focus scroll nor fires scroll events (no rendering frames),
    // so bring the row into view directly and deliver the scroll event a browser fires.
    $(root, ".tg-urgency.overdue").scrollIntoView({ block: "center", behavior: "instant" });
    scroller.dispatchEvent(new Event("scroll"));
    const beside = () => $(root, ".tg-tip") && inside($(root, ".tg-tip")) && Math.abs($(root, ".tg-tip").getBoundingClientRect().top - $(root, ".tg-urgency.overdue").getBoundingClientRect().bottom - 6) <= 2;
    for (let i = 0; i < 400 && !beside(); i += 1) await tick();
    check(beside(), `subgrid tooltip beside its icon: icon ${JSON.stringify($(root, ".tg-urgency.overdue").getBoundingClientRect())} tip ${JSON.stringify($(root, ".tg-tip")?.getBoundingClientRect())} scroll ${scroller.scrollTop}/${JSON.stringify(scroller.getBoundingClientRect())} active ${document.activeElement?.className}`);
    check(text(root, ".tg-tip") === "Overdue by 1 day", "tooltip stays inside the subgrid, under its icon");
    $(root, ".tg-urgency.overdue").blur();
    $(root, ".tg-more").click();
    await settled(root, sub, "subgrid load more");
    check(count(root) === "14 loaded · 14 matching records" && !$(root, ".tg-more"), `subgrid after Load more: ${count(root)}`);
    results.notes.push(`Subgrid 560x420: toolbar ${$(root, ".tg-toolbar").getBoundingClientRect().height}px, footer ${$(root, ".tg-footer").getBoundingClientRect().height}px, rows ${scroller.clientHeight}px`);
    if (stop("subgrid")) { results.pass = true; return; }

    // ============ 3.7.1 layering: Gantt layers stay inside the control, below Dynamics dialogs ============
    // Dynamics dialogs (app selector, Personal Settings, record dialogs) and the next page during navigation are positioned
    // layers with z-index auto (checked live in sandbox-simetrix). Two instances: a full-page view and a form subgrid, with
    // no stacking context around them, like the standalone Project Tasks view.
    mounted?.setRender(() => {});
    ReactDOM.unmountComponentAtNode(document.getElementById("host"));
    document.getElementById("host").style.display = "none";
    const captured = [];   // capture-phase pointerdown/keydown listeners on document: the Gantt's only global listeners
    const addListener = document.addEventListener, removeListener = document.removeEventListener;
    const isCapture = options => options === true || options?.capture === true;
    document.addEventListener = function (type, fn, options) { if (["pointerdown", "keydown"].includes(type) && isCapture(options)) captured.push(fn); return addListener.call(this, type, fn, options); };
    document.removeEventListener = function (type, fn, options) { if (["pointerdown", "keydown"].includes(type) && isCapture(options)) { const i = captured.indexOf(fn); if (i >= 0) captured.splice(i, 1); } return removeListener.call(this, type, fn, options); };
    const bodyChildren = () => Array.from(document.body.children);
    const bodyBefore = bodyChildren();
    const page = document.createElement("div");
    page.style.cssText = "position:relative;width:1300px;";
    document.body.appendChild(page);
    const mountAt = async (host, width, height) => {
      const element = document.createElement("div");
      element.style.cssText = `width:${width}px;height:${height}px;margin:12px;`;
      page.appendChild(element);
      const control = new TaskGantt();
      control.init(host.context, () => {});
      control.licenseState = "licensed";
      control.ensureLicenseValidation = () => {};
      let scheduled = false, renders = 0;
      const render = () => { if (scheduled) return; scheduled = true; setTimeout(() => { scheduled = false; renders += 1; ReactDOM.render(control.updateView(host.context), element); }, 0); };
      host.setRender(render);
      host.context.factory.requestRender = render;
      render();
      await until(() => element.querySelector(".tg-toolbar"), "instance rendered");
      await settled(element, host, "instance settled");
      return { element, control, host, renders: () => renders, destroy: () => { host.setRender(() => {}); ReactDOM.unmountComponentAtNode(element); control.destroy(); element.remove(); } };
    };
    const full = await mountAt(deadlineHost([], { height: 340 }), 1300, 340);
    const narrow = await mountAt(deadlineHost(extra, { width: 560, height: 360 }), 560, 360);
    window.scrollTo(0, page.getBoundingClientRect().top + window.scrollY);
    check(page.querySelectorAll("section.tg").length === 2, "two instances on one page");
    const inst = [full, narrow];
    // Open every Gantt layer: Filters popover, version note and the overdue tooltip.
    for (const { element } of inst) {
      button(element, "Filters").click();
      await until(() => $(element, ".tg-popover"), "popover open");
    }
    full.element.querySelector(".tg-info").click();
    await until(() => $(full.element, ".tg-info-overlay"), "version note open");
    check($(full.element, ".tg-info-overlay").closest("section.tg") && bodyChildren().length === bodyBefore.length + 1, "the version note is rendered inside the control, nothing is attached to the page body");
    $(full.element, ".tg-urgency.overdue").scrollIntoView({ block: "nearest", behavior: "instant" });
    window.scrollTo(0, page.getBoundingClientRect().top + window.scrollY);
    $(full.element, ".tg-urgency.overdue").focus();
    $(full.element, ".tg-scroll").dispatchEvent(new Event("scroll"));
    await until(() => $(full.element, ".tg-tip"), "tooltip open");
    check(document.elementFromPoint(...(r => [r.left + r.width / 2, r.top + 30])($(full.element, ".tg-popover").getBoundingClientRect())) .closest(".tg-popover"), "the Filters popover is still above the grid header");
    // Points on every Gantt layer: toolbar, sticky header, sticky task column, popover, version note, tooltip, bars.
    const layerPoints = () => inst.flatMap(({ element }) => [".tg-toolbar", ".tg-head .tg-col-task", ".tg-row .tg-col-task", ".tg-popover", ".tg-info-overlay", ".tg-tip", ".tg-bar", ".tg-footer"]
      .map(selector => [selector, element.querySelector(selector)]).filter(([, el]) => el).map(([selector, el]) => { const r = el.getBoundingClientRect(); return [selector, r.left + Math.min(20, r.width / 2), r.top + Math.min(10, r.height / 2)]; }))
      .filter(([, x, y]) => x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight);
    // A Dynamics-style layer: positioned, z-index auto, later in the document (dialog backdrop, side panel or next page).
    const dynamicsLayer = kind => {
      const layer = document.createElement("div");
      layer.className = `dyn-${kind}`;
      layer.style.cssText = kind === "dialog" ? "position:fixed;inset:0;background:rgba(0,0,0,0.4);" : "position:fixed;inset:0;background:#fff;";
      document.body.appendChild(layer);
      return layer;
    };
    const covered = layer => layerPoints().filter(([, x, y]) => document.elementFromPoint(x, y) !== layer).map(([selector]) => selector);
    // The 3.7.0 rules (no isolation, sticky toolbar at z-index 8, version note fixed at the maximum z-index) reproduce the report.
    const roots = Array.from(page.querySelectorAll("section.tg"));
    roots.forEach(root => { root.style.isolation = "auto"; Object.assign(root.querySelector(".tg-toolbar").style, { position: "sticky", zIndex: "8" }); });
    Object.assign($(full.element, ".tg-info-overlay").style, { position: "fixed", zIndex: "2147483000" });
    let probe = dynamicsLayer("dialog");
    const escaped = covered(probe);
    check(escaped.includes(".tg-toolbar") && escaped.includes(".tg-info-overlay"), `3.7.0 rules: the toolbar and version note draw over a Dynamics dialog (${escaped.join(", ")})`);
    probe.remove();
    roots.forEach(root => { root.style.isolation = ""; Object.assign(root.querySelector(".tg-toolbar").style, { position: "", zIndex: "" }); });
    Object.assign($(full.element, ".tg-info-overlay").style, { position: "", zIndex: "" });
    for (const kind of ["dialog", "panel", "next-page"]) {
      probe = dynamicsLayer(kind);
      const points = layerPoints();
      const left = covered(probe);
      check(points.length >= 14 && left.length === 0, `${kind}: every Gantt layer (${points.length} points) is below it${left.length ? `; still on top: ${left.join(", ")}` : ""}`);
      probe.remove();
    }
    // Sticky header still sticks inside the Gantt's own scroll area.
    const narrowScroller = $(narrow.element, ".tg-scroll");
    narrowScroller.scrollTo({ top: 120, behavior: "instant" });
    check(Math.abs($(narrow.element, ".tg-head").getBoundingClientRect().top - narrowScroller.getBoundingClientRect().top) <= 1, "the header stays at the top of the Gantt's scroll area");
    // Navigation away: Escape closes the layers; destroy removes listeners and every element; late async work renders nothing.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    $(full.element, ".tg-urgency.overdue").blur();
    await tick();
    const openListeners = captured.length;
    full.element.querySelector(".tg-info").click();
    button(full.element, "Filters").click();
    await until(() => $(full.element, ".tg-popover") && $(full.element, ".tg-info-overlay"), "layers reopened before navigating away");
    check(captured.length > openListeners, `global listeners only while a layer is open (${openListeners} -> ${captured.length})`);
    const rendersBefore = full.renders();
    const fullControl = full.control;
    full.destroy();
    narrow.destroy();
    fullControl.requestControlRender();                       // what a late license, metadata or link answer would do
    await tick(); await tick();
    check(captured.length === 0, `destroy leaves no document listeners (${captured.length})`);
    check(full.renders() === rendersBefore, "a destroyed control never renders again");
    check(!document.querySelector("section.tg, .tg-popover, .tg-info-overlay, .tg-tip") && bodyChildren().length === bodyBefore.length + 1, "destroy leaves no Gantt elements on the page");
    // Navigation back: a fresh instance works normally.
    const back = await mountAt(deadlineHost(), 1300, 420);
    check(page.querySelectorAll("section.tg").length === 1 && $$(back.element, ".tg-bar").length === 8, "navigating back renders one fresh instance");
    back.destroy();
    page.remove();
    document.addEventListener = addListener;
    document.removeEventListener = removeListener;
    document.getElementById("host").style.display = "";
    results.notes.push("Layering: 2 instances (full page and 560px subgrid), dialog/panel/next-page layers on top of every Gantt layer; destroy left no listeners or elements");

    results.pass = true;
  } catch (error) {
    results.error = error.message;
    results.stack = error.stack;
  } finally {
    document.getElementById("result").textContent = JSON.stringify(results);
  }
})();
