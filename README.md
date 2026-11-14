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
- Status uses the raw `statecode` value: `1` (Completed) shows as Completed in every UI language; every other state shows as Active.

### Custom tables

Only the maker's explicit bindings are used; no column is guessed by name and there is no Created On start fallback.
Column headers use the mapped columns' display names. A mapped Status shows its label. The Active/Completed/Overdue
filter is not offered for custom tables until the Completed value can be configured explicitly.

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

- **Project Operations** (`msdyn_projecttask`) uses `msdyn_projecttaskdependency` automatically. Reads are scoped to the
  project hosting the Gantt (or the single project of the loaded tasks when the view includes Project) and to active links.
  `msdyn_linktype` is authoritative (Finish-to-Start, Start-to-Start, Finish-to-Finish, Start-to-Finish);
  `msdyn_projecttaskdependencylinktype` is only a cross-check. Unknown or conflicting values are skipped and reported.
- **Custom link tables** opt in with all three settings and are drawn Finish-to-Start.
- Links are read with the signed-in user's permissions, 50 loaded tasks per request, once per task; links are kept by id so
  pages never duplicate them. A manual refresh reads them again.
- A link whose other end is not among the loaded rows (filtered out, on a later page or not accessible) shows a short stub;
  Load more reconnects it. Links inside the same collapsed group are hidden; links leaving a collapsed group are drawn
  dashed to the collapsed row, and duplicates are merged with a count.
- If the links cannot be read, the toolbar says **Dependencies unavailable** and the bars are unaffected.
- The **Dependencies** toolbar button hides or shows the lines for the current form.

## Dates

- A record with a missing Start or Finish stays in the list and opens normally. It shows **Unscheduled** with no bar.
- A Finish earlier than Start is flagged separately as **Invalid dates**.
- Date Only values are shown on their calendar day in every time zone.

## Behavior

- The dataset page size is 10, or 50 when Parent is mapped. The down arrow requests the next page of Dataverse records.
- After more than 10 records are loaded, an up arrow returns to the first rows.
- **Expand all** enters browser full-screen mode; **Close** exits it.
- The control responds to container width and browser zoom, with horizontal scrolling retained for the date timeline.
- Selecting a title opens the record.

## Build, test and deploy

1. Run `npm install`, `npm test` and `npm run build`.
   `npm test` runs every test under several time zones from UTC-11 to UTC+14.
   `npm run build` regenerates `TaskGantt/generated/ManifestTypes.d.ts`.
2. Create a solution project with Power Platform CLI.
3. Add this PCF project as a solution reference, build the solution, and import the generated solution ZIP.
4. Add a subgrid to the target model-driven form and configure this dataset control on it.
5. Map Title, Start and Finish, plus any optional property-sets you want displayed.

Important: `ownerid` is a user/team lookup, not a department. A true department display requires a separate Dataverse column or related lookup.
