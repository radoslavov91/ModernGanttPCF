# Changelog

The control identity never changes (`Voss.TaskGantt`, deployed as `simetrix_Voss.TaskGantt`), so every version
upgrades existing forms in place. Property-set names are the binding contract and are never renamed.

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
