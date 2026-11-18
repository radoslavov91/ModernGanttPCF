# Changelog

The control identity never changes (`Voss.TaskGantt`, deployed as `simetrix_Voss.TaskGantt`), so every version
upgrades existing forms in place. Property-set names are the binding contract and are never renamed.

## 3.7.1 (managed solution ModernGantt 1.0.0.13)

Gantt layers stay inside the control and below Dynamics dialogs.

- **Cause.** The toolbar was `position: sticky; z-index: 8`, and nothing in the control formed a stacking context, so
  that z-index competed with the page itself. Dynamics dialogs, the app selector and the page shown during navigation
  are positioned layers with `z-index: auto` (checked live in sandbox-simetrix: the dialog container chain is all
  `auto`), so the toolbar was drawn above them wherever no Dynamics ancestor contained it, as in the standalone Project
  Tasks view. Form subgrids in sandbox-simetrix happened to be contained by the form and were covered correctly. The
  version note was attached to `document.body` with `position: fixed; z-index: 2147483000`, above every dialog.
- **Fix.** `.tg` is now its own stacking context (`isolation: isolate`); the toolbar is a normal block above the rows
  (`position: relative; z-index: 2`) instead of sticky; the version note is rendered inside the control. Sticky headers,
  the Filters popover, tooltips and the version note keep their order inside the control. No Dynamics CSS or DOM is
  touched, and nothing is attached outside the control's element.
- **Teardown.** Document listeners exist only while the popover or version note is open and are removed on close and
  unmount. `destroy` marks the control destroyed, so late license, metadata, permission or link answers never render
  it again, and the license watchdog cannot restart; it also removes a version note left on the page by 3.7.0.

### Validation

| Check | Result |
| --- | --- |
| `npm test` | 9 files x 6 time zones, 0 failed |
| `npm run test:browser` | 98 checks. New: two instances (full page and a 560px form subgrid) with no stacking context around them; the 3.7.0 rules reproduce the report (toolbar and version note drawn over a dialog), and with 3.7.1 a dialog backdrop, a full-page panel and a next-page layer are on top of every Gantt layer (toolbar, sticky header and task column, popover, version note, tooltip, bars, footer); the popover stays above the grid header; the header stays sticky in the Gantt's own scroll area; destroy leaves no document listeners and no Gantt elements; a destroyed control never renders again; navigating back renders one fresh instance |
| Lint and production build | Clean; succeeded. Bundle SHA-256 `60B4784BFC3CD9B32D880423A71144032E9386EF3AF38A62CDAF693A6C44838B` (104,844 bytes); CSS `71EAA3E5…2C2E6B` |
| Live Dynamics | See Live acceptance |

### Release record

| Item | Value |
| --- | --- |
| Control bundle SHA-256 | `60B4784BFC3CD9B32D880423A71144032E9386EF3AF38A62CDAF693A6C44838B` (production build, 104,844 bytes) |
| Managed solution | `ModernGantt` 1.0.0.13, publisher `simetrix_consult`, includes `simetrix_licensecache` (exported from sandbox-simetrix) |
| Managed ZIP SHA-256 | `F4F1FD3873364711DEFC0725B4168C5DFC00DA0A00EACA0845D1C4FAE811F882` (`out/release-3.7.1/ModernGantt_1_0_0_13_managed.zip`) |
| Unmanaged ZIP SHA-256 | `1C29932B37B4353118BABFA903115D01CC81662B3E870B5F9A9F87FBEBC00BED` (`out/release-3.7.1/ModernGantt_1_0_0_13_unmanaged.zip`) |

### Deployment (sandbox-simetrix, 2026-11-18)

- Target confirmed: org `58e3db8a-3545-f111-b31f-000d3a69d77e`, as k.radoslavov@simetrixconsult.com.
- No new unrelated drafts: the same 8 first-party forms and 9 app sitemaps as at 3.7.0, nothing else (11,888 views,
  61,000 web resources, 21 apps, 181 charts unchanged). Published and draft fingerprints of those 8 forms and all 22
  sitemaps were taken before the import and again after Publish All (18:13-18:15 UTC): all 30 identical in both layers;
  the forms' publishedon dates are unchanged (Feb 2026).
- Live: `simetrix_Voss.TaskGantt` 3.7.1 (record and manifest, 13 properties); bundle and CSS SHA-256 match the build.
- Both ZIPs embed control 3.7.1 (13 properties, same bundle and CSS hashes) and `simetrix_licensecache` with every
  column the control uses; neither contains the temporary test table. Not imported into the trial (org3b1c1cb9).

### Live acceptance (sandbox-simetrix, 2026-11-18)

Probe: points on the toolbar, header, rows and footer of every visible Gantt, checked with `elementFromPoint` against
the real Dynamics layers.

| Host | Check | Result |
| --- | --- | --- |
| Standalone view (temporary table, Gantt Test app) | App switcher | Gantt covered at 12 of 12 points; toolbar dimmed under the overlay |
| | Settings panel | 58 Gantt points under the panel, none on top |
| | Personal Settings | Backdrop covers the Gantt at every point (the dialog content did not render in this browser session; it was closed by reloading the page) |
| | Record dialog | 406 Gantt points under the dialog, none on top; with the Filters popover and version note open, both are covered too |
| | Navigation away and back | Gantt removed within 250 ms, no Gantt elements left on the next page; back renders one fresh 3.7.1 instance |
| | Inside the Gantt | Filters popover draws above the grid header with focus inside; version note renders inside the control |
| Gantt Test form (two instances) | App switcher | Covered at all 7 visible points |
| | Record dialog | Page Gantts covered at all 7 points; the dialog's own two Gantts were removed when it closed |
| | Navigation away and back | No Gantt elements during or after leaving; back renders both instances (3.7.1) |

### Temporary test components (left in place for review)

| Component | Identifier |
| --- | --- |
| Unmanaged solution | `GanttStandaloneTest` (1.0.0.0, publisher `simetrix_consult`), id `ca13bc35-7be3-f111-84eb-7c1e5235d03b` |
| Table | `simetrix_ganttstandalonetest` (Gantt Standalone Test), MetadataId `38591311-c9a6-4473-96b2-058543fc0971`, with columns `simetrix_startdate`, `simetrix_finishdate` (Date Only), `simetrix_ismilestone`, lookup `simetrix_parentitem` (relationship `simetrix_ganttstandalonetest_parent`) and 11 sample rows |
| Table-level Gantt binding | `customcontroldefaultconfigs(dbf28606-25ce-46c1-a267-ceacea3a413b)` for this table only (web and tablet; phone keeps the grid) |
| Default view edited | Active Gantt Standalone Tests `7761cca7-a8a6-47e4-b31a-21b50a3b6f67` (columns for the Gantt) |
| Gantt Test app | View `7761cca7…` and main form `5d5a422b-fc85-4b27-8ab6-cc4541ed5c77` of the test table added; the app's sitemap and other components unchanged |

Deleting the table removes its rows, views, form and binding; then remove the two app components (if still listed) and
delete the `GanttStandaloneTest` solution.

### Project Operations verification (simetrix_demo trial, 2026-11-18)

Configuration and documentation only; no control release and no task data changed by these checks.

**Completion scale (verified).** `msdyn_projecttask.msdyn_progress` ("% Complete") is a Decimal, 0 to 100, 2 decimals,
stored as a percentage:

| Task (project 888) | Stored `msdyn_progress` | Effort completed / planned |
| --- | --- | --- |
| 888 - Building Permits | 100 | 32 / 32 h |
| 888 - Customer satisfaction inspection | 100 | 64 / 64 h |
| 888 - Planning Activities (summary) | 11.76 | 32 / 272 h |
| 888 - Project Inspection (summary) | 16.33 | 64 / 392 h |

Completion settings for Project Operations tasks: `progressColumn = msdyn_progress`, `progressCompleteValue = 100`.
Earlier checks in the same trial: a % Complete typed on the Task details form is rejected by the scheduling service
(`ScheduleAPI-SRV-0008`) even with **Allow percent complete update** = Yes; that form divides the typed value by 100
before calling `msdyn_ExecuteOperationSetV3`. The project setting is forced to No and locked when a project has a sales
order.

**Gantt settings found in the trial (control 3.7.1).**

| Where | `progressColumn` | `progressCompleteValue` | Warning days (yellow / orange / dark orange) |
| --- | --- | --- | --- |
| Project form "Information" (`105ef076-a72a-4382-bde5-35e3c3d9db40`), web, tablet and phone | `msdyn_Progress` | 100 | 20 / 10 / 5 |
| View "Modern Gantt Test - Project Tasks" (`c8f9b954-a6df-f111-84e8-70a8a505d0b6`) | `msdyn_progress` | 100 | 20 / 10 / 5 |
| Project form "Modern Gantt Test" | not set (neutral rows) | not set | product defaults |

20 / 10 / 5 days is the trial's own setting; the product defaults remain 2 / 1 / 0. The `msdyn_Progress` casing is
accepted (column names match regardless of case).

**View-specific binding (observed).** The trial binds the Gantt to a single view: "Modern Gantt Test - Project Tasks"
carries the control in its `layoutxml` (`controlDescriptions`), while other views of `msdyn_projecttask` keep the
standard grid and no table-level Gantt binding exists. Microsoft's documentation only describes the table-wide route.

**Project form Parent binding corrected.** The Information form's Gantt bound Parent to `msdyn_projectsprint` (a sprint
lookup with no values), so the hierarchy stayed flat.

- Changed `<parent>` to `msdyn_parenttask` for web, tablet and phone (3 values); the draft was checked to differ from the
  published form only by those values, and only the project table's customizations were published (`PublishXml`
  entity `msdyn_project`; no other project form or view had drafts).
- Added `msdyn_parenttask` to the bound view "All Project Tasks" (`1a0f550d-9c2b-4007-82e0-e52c06f59c88`, column and
  layout cell) and published the project task table's customizations (no other project task form or view had drafts).
  Bound columns that are not in the view (display sequence) did reach the dataset, so this addition may not have been
  strictly required.
- After a full page reload (the client kept the previous form definition until then), project 888's Gantt shows the
  hierarchy: 32 tasks in 5 summary groups with 27 children, matching the stored outline levels, no notices, and the two
  completed tasks green. The standalone view "Modern Gantt Test - Project Tasks" already bound Parent to
  `msdyn_parenttask`.

## 3.7.0 (managed solution ModernGantt 1.0.0.12)

Refined appearance, localized status filters, deadline colours and the overdue indicator.

- **Appearance (from the PoC).** Two-row toolbar: title, refresh and record count with the Dependencies switch and
  dependency note; then search (when `searchColumn` is set), a **Filters** popover (Column, Condition, Value), the date
  filters, the status filter as a compact segmented control and **Today**. Controls are 32px high and aligned; grid
  lines and header are softer; today's date is marked in the calendar header. The colour legend, **Load more** and back to
  top moved to a footer outside the scrolling rows, so they and the count stay visible at 100% zoom. Narrow form subgrids
  wrap the toolbar without horizontal overflow. Columns, bindings and behaviour are unchanged; the status column is 20px
  wider in full-page views so localized labels fit.
- **Status labels in filter dropdowns.** 3.6.0 read option labels from `Label`, but model-driven hosts return
  `{ "0": { text: "Open", value: 0 } }` (checked in sandbox-simetrix on 2026-11-18), so the dropdown listed raw values
  such as 0, 1, 2. Labels now come from either metadata shape and are always Dataverse's localized text; filters still
  send the raw value. The status pill also shows the localized label (3.6.0 showed fixed English names for Task states).
- **Deadline colours.** Completion is configured explicitly with raw values: `completedStatusValues`,
  `canceledStatusValues`, or `progressColumn` with `progressCompleteValue`. The standard Task `statecode` keeps its built-in
  0/1/2 values. Open rows go blue → yellow → orange → dark orange as Finish approaches (`dueSoonDays`, `dueNearDays`,
  `dueImminentDays`, defaults 2/1/0, keeping 3.6.0's two-day due-soon boundary) and red when overdue; completed green,
  canceled grey; summary bars unchanged. Invalid settings switch colours off with a notice. Configured values are
  checked against metadata options.
- **Project Operations.** (Since verified: percentage scale, `progressCompleteValue = 100`; see 3.7.1.) Completion was not yet configured or verified. An Active state alone may not mean unfinished,
  so nothing is assumed; project tasks stay neutral until completion is configured, and the footer says so. The progress
  column's metadata and actual value range will be checked in the trial (org3b1c1cb9) before choosing the completion
  threshold.
- **Overdue indicator.** A red warning icon beside overdue names, focusable, with an "Overdue by 1 day" / "Overdue by N
  days" tooltip on hover and keyboard focus; the text is also its accessible name and appears in the bar tooltip. The
  3.6.0 due-soon triangle icon is replaced by the bar colours and bar tooltips ("Due today", "Due tomorrow", "Due in N days").
- **One deadline calculation** for colours, icon, tooltips and the Overdue filter, in calendar days in the user's
  Dynamics time zone. User-local Date and Time columns are converted with `getTimeZoneOffsetMinutes`; Date Only and
  time-zone-independent columns (behavior read from metadata) keep their stored day. The Overdue filter now asks for
  Finish on or before the user's yesterday (3.6.0 compared with the current instant, so a task due earlier today could be
  filtered as overdue). Tasks due today, completed or canceled are never overdue.
- Date and Time values are placed on their calendar day (3.6.0 kept the instant; bars already snapped to whole days).

### Validation

| Check | Result |
| --- | --- |
| `npm test` | 9 files x 6 time zones, 0 failed (new `taskgantt-deadline.test.js`) |
| `npm run test:browser` (headless Edge, real control and CSS) | 85 checks, including deadline colours with the Dynamics user on UTC+14 and the browser on Europe/Sofia, overdue icon focus and hover tooltips, the Overdue filter evaluated by the simulated server, host-shaped status metadata, a 560x420 form subgrid (no overflow, count/legend/Load more visible, popover above the grid with focus in and Escape returning focus, Today) and the full-page footer at 100% zoom |
| Lint and production build | Clean; succeeded. Bundle SHA-256 `F369CA78AE57CFBA7A52B8CEFA02EB03D44CB5690DF58F18468F3B6EEABE8C3A` (105,143 bytes) |

### Release record

| Item | Value |
| --- | --- |
| Control bundle SHA-256 | `F369CA78AE57CFBA7A52B8CEFA02EB03D44CB5690DF58F18468F3B6EEABE8C3A` (production build, 105,143 bytes) |
| Managed solution | `ModernGantt` 1.0.0.12, publisher `simetrix_consult`, includes `simetrix_licensecache` (exported from sandbox-simetrix) |
| Managed ZIP SHA-256 | `8C5676359836101CA0113EC4A40533ACD43132ACAA0C794E05AFEF9A7FA6612D` (`out/release-3.7.0/ModernGantt_1_0_0_12_managed.zip`) |

### Deployment (sandbox-simetrix, 2026-11-18)

- Target confirmed: org `58e3db8a-3545-f111-b31f-000d3a69d77e`, as k.radoslavov@simetrixconsult.com.
- Pending-changes check: no pending views (11,888), web resources (61,000), apps or charts. Unrelated drafts that
  differed from the published definitions: 8 first-party forms (Price Level, Record Creation and Update Rule - UCI,
  Sales Insights, Quick Campaign, Quick Campaign (deprecated), Select records to apply sequence, and two Information
  forms) and 9 of the 22 app sitemaps. Publish All was approved with that risk.
- Both layers of those 8 forms and all 22 sitemaps were snapshotted (SHA-256 per definition), the tested build was
  imported unpublished in the `PowerAppsToolsTemp_simetrix` wrapper, then Publish All ran (15:57-15:59 UTC). Afterwards
  all 8 forms and 22 sitemaps were identical to the snapshot in both the published and the draft layer, and the forms'
  publishedon dates were unchanged (Feb 2026): Publish All did not publish these drafts.
- Live: `simetrix_Voss.TaskGantt` 3.7.0 (record and manifest) with all 13 properties, including the 7 new ones; live
  bundle SHA-256 matches the release record; live CSS matches the local build.
- The managed ZIP embeds control 3.7.0 (13 properties, same bundle and CSS hashes) and the `simetrix_licensecache`
  table with every column the control uses. Not imported into the Project Operations trial (org3b1c1cb9).

## 3.6.0 (managed solution ModernGantt 1.0.0.11)

Portfolio views, search, column filters and record counts.

- **Multi-project dependency lines.** Diagnosis of "Dependencies unavailable" in the Project Tasks view: 3.5.0 scoped links
  to a project form, or to the loaded rows only when they all shared one project (`projects.size === 1`). A view spanning
  several projects therefore had no scope, read nothing and showed "Dependencies need the current project ... or add the
  Project column to the view", even with the Project column present. Now each row's Project lookup scopes its own links:
  each 50-task batch filters on the projects of its tasks (`eq` for one, `in` for several; identical FetchXML to 3.5.0 on
  project forms), active links only, with the user's permissions. Links stay deduplicated by id across pages and projects;
  Load more reads only new tasks and never resets; stubs and collapsed groups behave as before.
- Clear reasons: **Dependencies unavailable: no project** (no project form and no Project column, or no row has a
  Project), **: no access** (missing read privilege on the link table, with the Dataverse text in the tooltip), and
  "N tasks without a project" when some rows have an empty Project.
- **Search:** optional `searchColumn` (text column logical name) adds a labelled Contains search box. The column is
  verified from the view or metadata, and checked against column permissions.
- **Column filters ("Filter by"):** text Contains/Equals; choice and status from metadata options (raw values, localized
  labels, no completion inferred from labels); dates On/Before/After with Dataverse day semantics for the column's
  behavior. Chips with individual clear buttons, header filter marks, **Clear all filters** (also clears the toolbar filters).
- Filtering follows Modern Smart Grid 2.2.3: server-side through the PCF filtering API only, ANDed with the re-derived
  host filter (saved view, Edit filters and subgrid relationship survive), back to page 1. If the host replaces the
  Gantt's conditions, the Gantt clears its own criteria with a notice and never writes a guessed filter. Columns are
  offered only when searchable and readable for every row (unsecured, or secured with organization-wide read);
  unverifiable permissions offer nothing and say so. Hosts without `getFilter` keep the 3.5.0 toolbar filters.
- **Record counts:** "50 loaded · 126 matching records" from `totalResultCount`, shown only when consistent with the loaded
  rows; otherwise "matching total unavailable", and 5,000+ is labelled as capped. "· N visible" appears when collapsed
  groups hide rows; the total is unchanged. The last count stays visible (dimmed) during refresh, search, filtering and Load more.
- Toolbar status/date filters are now ANDed with the host filter instead of replacing it.

### Completion semantics (no inference from labels)

- Completion, overdue and due-soon styling come only from known raw values. The standard Task table with Status bound to
  `statecode` is the only mapping with them: 0 Open (Active), 1 Completed, 2 Canceled.
- Every other mapping (custom tables, Tasks bound to Status Reason) shows its status text as returned and uses neutral
  scheduling styling: the standard bar colour with no completed, overdue or due-soon variants and no check mark.
- Removed: learning the Completed value from a "Completed" label (3.5.0 did this for Tasks bound to another status column),
  and label-based Completed bars on custom tables. Metadata-based status filtering (Filter by) is unchanged.
- Canceled Tasks are shown as Canceled (grey, never overdue); 3.5.0 showed them as Active. The toolbar Active and Overdue
  filters now match Open (`statecode` 0) instead of "not Completed", so Canceled tasks no longer appear under Active.

### Validation

| Check | Result |
| --- | --- |
| `npm test` | 8 files x 6 time zones, 0 failed |
| `npm run test:browser` (headless Edge, real control and CSS) | 47 checks: multi-project view (2 projects, 62 tasks), collapse, search, choice and date filters, clear one and all, Load more reconnect, project form scope, missing Project column, standard Tasks (German status labels), custom Date Only table |
| Lint and production build | Clean; succeeded |

### Release record

| Item | Value |
| --- | --- |
| Control bundle SHA-256 | `52D9DEA28D155CCD54B7889C99DFCB44D0F8DA0EAA9F0308B567D5064452637A` (production build, 92,662 bytes) |
| Managed solution | `ModernGantt` 1.0.0.11, publisher `simetrix_consult`, includes `simetrix_licensecache` (exported from sandbox-simetrix) |
| Managed ZIP SHA-256 | `1EBD60B37364FE85CBC2FBFDD5EF487CD1A3136B221DA4B1F79E1BDF2507B6F5` (`out/release-3.6.0/ModernGantt_1_0_0_11_managed.zip`) |

### Deployment (sandbox-simetrix, 2026-11-18)

- Target confirmed: org `58e3db8a-3545-f111-b31f-000d3a69d77e`, as k.radoslavov@simetrixconsult.com.
- Pending-changes check (published layer compared with `RetrieveUnpublishedMultiple`): no pending views, web resources,
  apps or charts. Nine first-party app sitemaps had drafts that differed from the published XML (Sales Hub, Customer
  Service Hub, Field Service and others). They predated the 3.5.0 push.
- The control was imported without publishing (production bundle in the unmanaged `PowerAppsToolsTemp_simetrix` wrapper,
  as `pac pcf push` builds it). A publish scoped to the control's web resources made the bundle live, but the custom-control
  record (manifest) only updates through Publish All, so Publish All was run with approval. All 22 app sitemaps were
  hashed before and after: none changed.
- Live: `simetrix_Voss.TaskGantt` 3.6.0 (record and manifest, `searchColumn` present); live bundle SHA-256 matches the
  release record. The managed ZIP embeds the same control and bundle and the `simetrix_licensecache` table with all 13
  columns the control uses.
- Not imported into the Project Operations trial (org3b1c1cb9).

## 3.5.0 (managed solution ModernGantt 1.0.0.10)

Read-only dependency lines.

- One link engine for Project Operations and opt-in custom link tables.
  - Project Operations (`msdyn_projecttask`) reads `msdyn_projecttaskdependency`, scoped to the current project and to
    active links. `msdyn_linktype` is authoritative; `msdyn_projecttaskdependencylinktype` is only a cross-check.
    Unknown or conflicting link types are skipped and reported.
  - Custom link tables opt in with `dependencyTable`, `dependencyPredecessorColumn` and `dependencySuccessorColumn`
    and are drawn Finish-to-Start.
  - `dependencyMode` (Auto/Off, default Auto) and a **Dependencies** toolbar toggle.
- Links are read with the signed-in user's permissions, 50 loaded tasks per request, once per task, deduplicated by id.
- Stubs for ends that are filtered out, on a later page or not accessible; Load more reconnects them. Links inside the
  same collapsed group are hidden; links leaving one are drawn dashed to the collapsed row with a count.
- A failed read shows "Dependencies unavailable"; bars, dates and hierarchy are unaffected.
- Existing flat and hierarchy configurations render byte-identically to 3.4.0 (39 compared variants).
- Manifest display and description text must not contain apostrophes (Dataverse rejects them at import); a test
  now enforces this.

### Link types

- **Finish-to-Start was verified live**, including on-screen rendering in both environments (see Live acceptance).
  All 294 readable Project Operations links in the trial (`msdyn_linktype` 192350000, mirror value 1) and the custom
  Gantt Test Link in sandbox-simetrix are Finish-to-Start.
- **Start-to-Start, Finish-to-Finish and Start-to-Finish were tested with fixtures only**
  (`tests/fixtures/po-dependencies.json`); no live data of these types exists.

### Release record

| Item | Value |
| --- | --- |
| Control bundle SHA-256 | `985335E9393BB539CBF414CCC774A3B2D866CADED1802E3F73CDCA83DCAB8049` |
| Managed solution | `ModernGantt` 1.0.0.10, publisher `simetrix_consult`, includes `simetrix_licensecache` |
| Managed ZIP SHA-256 | `FE1DBDCEDBE3EF41106C3B2BFDFB7BCC455A8F14A28F2DDA3C828BC22FCCFA1D` (exported from sandbox-simetrix) |

### Live acceptance (2026-11-14)

| Environment | Result |
| --- | --- |
| sandbox-simetrix, deployment | 3.5.0 pushed after a clean pending-changes check; live control 3.5.0 with the bundle hash above. Gantt Test Link table with one Finish-to-Start link (P2 Child A - Design → P2 Child B - Build); the Phase 2 Gantt on the Gantt Test form is configured for it and the control's link query returns it. The Flat Gantt stays unconfigured. |
| sandbox-simetrix, browser | The Phase 2 Gantt on the Gantt Test form rendered the Finish-to-Start arrow from P2 Child A - Design (finish 27 Nov) to P2 Child B - Build (start 30 Nov). |
| org3b1c1cb9 (Project Operations trial), browser | Managed ModernGantt 1.0.0.10 imported; control 3.5.0 confirmed on project 555 (GanttTestPO, Modern Gantt Test form). Store Design → Material Sourcing showed the correct Finish-to-Start arrow and tooltip. The links-to-rows-not-loaded notice cleared after paging, and collapsing Planning Activities hid its internal links. |
| Start-to-Start, Finish-to-Finish, Start-to-Finish | Fixture-tested only; no live data of these types exists. |

## 3.4.0 (managed solution ModernGantt 1.0.0.9)

Expandable hierarchy, summary bars and milestone diamonds.

- Optional `parent`, `milestone` and `sequence` mappings; Project Operations defaults (`msdyn_subject`, `msdyn_start`,
  `msdyn_finish`, `msdyn_parenttask`, `msdyn_summary`, `msdyn_ismilestone`, `msdyn_displaysequence`), applied only to
  columns in the view.
- Page size 50 with hierarchy, 10 for flat views.
- Rows whose parent is not loaded stay at the top level and nest when it loads; parent names only when Dataverse
  returned them.
- Summary bars use stored dates; spans derived from loaded children are dashed and marked possibly incomplete.

## 3.3.0

Generic custom-table support.

- Only Title, Start and Finish are required; Owner, Status, Created On and Description are optional.
- Date Only and Date and Time columns; Date Only values stay on their calendar day in every time zone.
- Tests run under six time zones (`npm test`).
