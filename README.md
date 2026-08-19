# Task Gantt PCF

Responsive virtual React dataset control for the Dataverse OOB Task table.

## OOB field mapping

| Gantt column | Task column |
| --- | --- |
| Task name | `subject` |
| Assigned to | `ownerid` |
| Status | `statecode` (Completed maps to Completed; every other state displays as Active) |
| Start Date | `createdon` (date only in the UI) |
| Due Date | `scheduledend` (date only in the UI) |

The Task ID column was intentionally removed because no suitable OOB display ID exists.

## Behavior

- The dataset page size is 10. The down arrow requests the next 10 Dataverse records.
- After more than 10 records are loaded, an up arrow returns to the first rows.
- **Expand all** enters browser full-screen mode; **Close** exits it.
- The control responds to container width and browser zoom, with horizontal scrolling retained for the date timeline.
- Selecting a task subject opens the Task record.

## Build and deploy

1. Run `npm install` and `npm run build`.
2. Create a solution project with Power Platform CLI.
3. Add this PCF project as a solution reference, build the solution, and import the generated solution ZIP.
4. Add a Task subgrid to the target model-driven form and configure this dataset control on it.
5. Map the five manifest property sets to the corresponding OOB Task columns listed above.

Important: `ownerid` is a user/team lookup, not a department. A true department display requires a separate Dataverse column or related lookup.
