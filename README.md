# Task Gantt PCF

Responsive virtual React dataset control for the Dataverse Task table and for custom Dataverse tables.

## Field mapping

The property-set names are the binding contract with forms that already host the control and must not be renamed.
Only Title, Start and Finish are required. Optional columns and filters appear only when mapped.

| Property-set | Label | Required | Accepted types | Standard Task column |
| --- | --- | --- | --- | --- |
| `subject` | Title | Yes | Single line of text | `subject` |
| `scheduledstart` | Start | Yes | Date Only, Date and Time | `scheduledstart` |
| `scheduledend` | Finish | Yes | Date Only, Date and Time | `scheduledend` |
| `ownerid` | Owner | No | Owner lookup | `ownerid` |
| `statecode` | Status | No | Choice | `statecode` |
| `createdon` | Created On | No | Date and Time | `createdon` |
| `description` | Description | No | Single line of text, Text area, Multiple lines of text | (not shown unless bound) |
| `parent` | Parent | No | Lookup to the same table | — |
| `milestone` | Milestone | No | Yes/No | — |
| `sequence` | Sequence | No | Whole number, Decimal, Float | — |

### Standard Tasks

The control detects the Task table from the bound dataset. Explicit bindings win; unbound property-sets fall back to
the standard Task columns above, so existing Tasks configurations keep their 3.2.1 layout and labels.

- Start uses `scheduledstart`, falling back to `createdon`.
- Status bound to `statecode` has built-in completion semantics from the raw value: `0` Open (Active), `1` Completed,
  `2` Canceled, in every UI language. The status text is always the localized Dataverse label.

### Custom tables

Only the maker's explicit bindings are used; no column is guessed by name and there is no Created On start fallback.
Column headers use the mapped columns' display names. A mapped Status shows its label. Deadline colours and the
Active/Completed/Overdue filter need explicit completion settings (see Deadline colours).

### Project Operations (`msdyn_projecttask`)

Explicit bindings win. Unbound mappings fall back to these columns, verified on `msdyn_projecttask`, but only when the
column is in the view. Missing hierarchy columns are named in a notice and their features stay off.

| Mapping | Column |
| --- | --- |
| Title | `msdyn_subject` |
| Start / Finish | `msdyn_start` / `msdyn_finish` |
| Parent | `msdyn_parenttask` |
| Summary flag (no property-set) | `msdyn_summary` |
| Milestone | `msdyn_ismilestone` |
| Sequence | `msdyn_displaysequence` |

Project Operations completion is **not yet configured or verified**. An Active state alone may not mean the task is
unfinished, so the control does not assume it, and rows stay neutral until completion is configured (see Deadline
colours). The progress column's metadata and actual value range will be checked in the Project Operations trial before
a completion threshold is chosen.

## Deadline colours

Completion comes only from raw values; labels are never interpreted. Without known semantics, rows use the neutral blue
bar, no row is overdue and the footer says **Deadline colours off: completion not configured**.

| Property | Purpose |
| --- | --- |
| `completedStatusValues` | Raw values of the mapped Status column that mean Completed, comma separated (for example `5` for Task Status Reason Completed). Every other value is open. |
| `canceledStatusValues` | Raw values that mean Canceled. Optional; requires Completed values. |
| `progressColumn` | Logical name of a number column in the view. A row is Completed when it reaches `progressCompleteValue` (default 100; use 1 for fractions). Takes precedence over status values. |
| `dueSoonDays` / `dueNearDays` / `dueImminentDays` | Days before Finish at which open rows turn yellow / orange / dark orange. Defaults 2 / 1 / 0 (the 3.6.0 two-day due-soon boundary). Must not increase. |

- Open rows are blue, then yellow, orange and dark orange as Finish approaches, and red from the day after Finish.
  A task due today is dark orange, never overdue. Completed rows are green with a check mark, canceled rows grey.
  Summary bars keep their dark bracket; milestones take the row colour.
- Overdue tasks have a red warning icon beside the name. Hover or keyboard focus shows "Overdue by 1 day" /
  "Overdue by N days"; the same text is the icon's accessible name and appears in the bar tooltip.
- One calculation drives colours, the icon, tooltips and the **Overdue** filter. Days are calendar days in the user's
  Dynamics time zone (`getTimeZoneOffsetMinutes`); user-local Date and Time columns are converted to it, Date Only and
  time-zone-independent columns keep their stored day. The Overdue filter asks Dataverse for Finish on or before the
  user's yesterday, which Dataverse evaluates with the same column behavior.
- Configured status values are checked against the column's metadata options; invalid settings switch the colours off
  with a notice instead of guessing.

## Hierarchy, summary bars and milestones

- Mapping Parent turns on expandable rows. Rows start expanded; collapsed rows are remembered while the form is open.
- Rows are ordered under their parent by the column sort, or by Sequence when no column sort is chosen.
- A row whose parent is not among the loaded rows (filtered out, on a later page or not accessible) stays visible at
  the top level and nests automatically once the parent loads. The parent's name is shown only when Dataverse returned it.
- A row with loaded children, or a Project Operations summary task, shows a summary bar. Its stored Start and Finish win.
  Without both stored dates, the span is derived from the loaded children and drawn dashed, marked "may be incomplete".
- Milestones use the explicit flag only: a diamond on Finish, or on Start when Finish is empty.
- Rows whose parent forms a loop are shown at the top level with one console warning.
- A Parent lookup to a different table shows a notice, and rows stay flat.

## Dependency lines (read-only)

| Property | Purpose |
| --- | --- |
| `dependencyMode` | **Auto** (default) draws lines for Project Operations tasks or a configured link table; **Off** hides them. |
| `dependencyTable` | Optional. Logical name of a custom link table. |
| `dependencyPredecessorColumn` / `dependencySuccessorColumn` | Optional. Logical names of that table's lookups to the predecessor and successor rows. |

- **Project Operations** (`msdyn_projecttask`) uses `msdyn_projecttaskdependency` automatically. Reads are scoped to
  active links and to the project hosting the Gantt; outside a project form, each loaded row's **Project** lookup scopes
  its links, so multi-project views read the links of every represented project. Such views need the Project column;
  without it the toolbar says **Dependencies unavailable: no project**, and rows with an empty Project are counted and not read.
  `msdyn_linktype` is authoritative (Finish-to-Start, Start-to-Start, Finish-to-Finish, Start-to-Finish);
  `msdyn_projecttaskdependencylinktype` is only a cross-check. Unknown or conflicting values are skipped and reported.
- **Custom link tables** opt in with all three settings and are drawn Finish-to-Start.
- Links are read with the signed-in user's permissions, 50 loaded tasks per request, once per task; links are kept by id so
  pages never duplicate them. A manual refresh reads them again.
- A link whose other end is not among the loaded rows (filtered out, on a later page or not accessible) shows a short stub;
  Load more reconnects it. Links inside the same collapsed group are hidden; links leaving a collapsed group are drawn
  dashed to the collapsed row, and duplicates are merged with a count.
- If the links cannot be read, the toolbar says **Dependencies unavailable** (**: no access** when the user lacks read
  permission on the link table) with the reason in its tooltip, and the bars are unaffected.

## Search, column filters and record counts

| Property | Purpose |
| --- | --- |
| `searchColumn` | Optional. Logical name of a text column. Shows a labelled search box that finds records whose value contains the text. |

- **Filters** opens a popover (Column, Condition, Value; Escape or Cancel closes it) with the view's own columns: text (Contains, Equals), choice and status (a dropdown of the options
  defined in metadata, filtered by raw value and shown with the user's localized labels, read from either metadata shape
  the host returns) and dates (On, Before, After,
  using the column's Date Only, user-local or time-zone-independent behavior). Lookups and linked-table columns are not offered.
- A column is offered only when the user may filter by it: unsecured, or secured with organization-wide read access, and
  searchable. If column permissions cannot be verified, nothing is offered and the toolbar says so.
- Search and filters run in Dataverse over every page, through the PCF filtering API only. They are ANDed with the saved
  view, the host's own filter (for example Edit filters) and the subgrid relationship, and return to page 1. Each active
  filter is a chip with its own clear button; filtered columns are marked in the header; **Clear all filters** also clears
  the toolbar filters. If the host replaces the Gantt's conditions, the Gantt clears its own criteria and says so.
- The toolbar shows "50 loaded · 126 matching records" using the count Dataverse reports for the current view, search and
  filters. A missing or inconsistent total reads **matching total unavailable**; 5,000 or more reads
  **5,000+ matching records (count limit reached)**. Collapsed groups add "· N visible" and never change the total.
- The **Dependencies** switch hides or shows the lines for the current form. **Today** scrolls the timeline to today.
- The colour legend, **Load more** and the back-to-top button sit in a footer outside the scrolling rows, so they and the
  record count stay visible at 100% zoom in full-page views and narrow form subgrids.

## Dates

- A record with a missing Start or Finish stays in the list and opens normally. It shows **Unscheduled** with no bar.
- A Finish earlier than Start is flagged separately as **Invalid dates**.
- Date Only values are shown on their calendar day in every time zone; Date and Time values on their day in the user's
  Dynamics time zone.

## Behavior

- The dataset page size is 10, or 50 when Parent is mapped. **Load more** requests the next page of Dataverse records.
- After more than 10 records are loaded, an up arrow returns to the first rows.
- **Expand all** enters browser full-screen mode; **Close** exits it.
- The control responds to container width and browser zoom, with horizontal scrolling retained for the date timeline.
- Selecting a title opens the record.

## Build, test and deploy

1. Run `npm install`, `npm test` and `npm run build`.
   `npm test` runs every test under several time zones from UTC-11 to UTC+14.
   `npm run test:browser` runs the interactive scenarios in headless Edge (set `GANTT_TEST_BROWSER` for another
   Chromium browser) and writes screenshots to `out/browser-tests`.
   `npm run build` regenerates `TaskGantt/generated/ManifestTypes.d.ts`.
2. Create a solution project with Power Platform CLI.
3. Add this PCF project as a solution reference, build the solution, and import the generated solution ZIP.
4. Add a subgrid to the target model-driven form and configure this dataset control on it.
5. Map Title, Start and Finish, plus any optional property-sets you want displayed.

Important: `ownerid` is a user/team lookup, not a department. A true department display requires a separate Dataverse column or related lookup.
