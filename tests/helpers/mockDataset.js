// Minimal stand-ins for the PCF dataset and context used by TaskGantt.updateView.

const TASK_COLUMNS = [
  { name: "subject", alias: "subject", dataType: "SingleLine.Text", displayName: "Subject" },
  { name: "scheduledend", alias: "scheduledend", dataType: "DateAndTime.DateAndTime", displayName: "Due Date" },
  { name: "ownerid", alias: "ownerid", dataType: "Lookup.Owner", displayName: "Owner" },
  { name: "statecode", alias: "statecode", dataType: "OptionSet", displayName: "Activity Status" },
  { name: "scheduledstart", alias: "scheduledstart", dataType: "DateAndTime.DateAndTime", displayName: "Start Date" },
  { name: "createdon", alias: "createdon", dataType: "DateAndTime.DateAndTime", displayName: "Created On" }
];

// A minimal organization-owned custom table: only Title, Start and Finish are bound (Date Only).
const CUSTOM_COLUMNS = [
  { name: "cr123_name", alias: "subject", dataType: "SingleLine.Text", displayName: "Name" },
  { name: "cr123_plannedstart", alias: "scheduledstart", dataType: "DateAndTime.DateOnly", displayName: "Planned Start" },
  { name: "cr123_plannedfinish", alias: "scheduledend", dataType: "DateAndTime.DateOnly", displayName: "Planned Finish" }
];

// The Gantt Test Item table in sandbox-simetrix, with the Phase 2 mappings bound.
const HIERARCHY_COLUMNS = [
  { name: "simetrix_name", alias: "subject", dataType: "SingleLine.Text", displayName: "Name" },
  { name: "simetrix_startdate", alias: "scheduledstart", dataType: "DateAndTime.DateOnly", displayName: "Start Date" },
  { name: "simetrix_finishdate", alias: "scheduledend", dataType: "DateAndTime.DateOnly", displayName: "Finish Date" },
  { name: "simetrix_parentitem", alias: "parent", dataType: "Lookup.Simple", displayName: "Parent Item" },
  { name: "simetrix_ismilestone", alias: "milestone", dataType: "TwoOptions", displayName: "Milestone" },
  { name: "simetrix_sequence", alias: "sequence", dataType: "Whole.None", displayName: "Sequence" }
];

// msdyn_projecttask with only Title, Start and Finish bound; the hierarchy columns are plain view columns.
const PROJECT_TASK_COLUMNS = [
  { name: "msdyn_subject", alias: "subject", dataType: "SingleLine.Text", displayName: "Project Task Name" },
  { name: "msdyn_start", alias: "scheduledstart", dataType: "DateAndTime.DateAndTime", displayName: "Start" },
  { name: "msdyn_finish", alias: "scheduledend", dataType: "DateAndTime.DateAndTime", displayName: "Finish" },
  { name: "msdyn_parenttask", dataType: "Lookup.Simple", displayName: "Parent Task" },
  { name: "msdyn_summary", dataType: "TwoOptions", displayName: "Summary" },
  { name: "msdyn_ismilestone", dataType: "TwoOptions", displayName: "Milestone" },
  { name: "msdyn_displaysequence", dataType: "Decimal", displayName: "Display Sequence" }
];

function makeDataset({ entityType, columns, rows, hasNextPage = false, loading = false }) {
  const calls = { setPageSize: [], setFilter: [], clearFilter: 0, reset: 0, refresh: 0, loadNextPage: 0, opened: [] };
  const records = {};
  rows.forEach(row => {
    records[row.id] = {
      getValue: name => row.values[name] === undefined ? null : row.values[name],
      getFormattedValue: name => {
        if (row.formatted && row.formatted[name] !== undefined) return row.formatted[name];
        const value = row.values[name];
        if (value === null || value === undefined) return "";
        // Lookups format as their display name, or empty when the platform returned none.
        if (typeof value === "object" && !(value instanceof Date)) return value.name || "";
        return String(value);
      },
      getNamedReference: () => ({ id: { guid: row.id }, etn: entityType, name: row.values[columns[0].name] })
    };
  });

  const ds = {
    columns,
    records,
    sortedRecordIds: rows.map(row => row.id),
    loading,
    sorting: [],
    getTargetEntityType: () => entityType,
    paging: {
      hasNextPage,
      setPageSize: size => calls.setPageSize.push(size),
      loadNextPage: () => { calls.loadNextPage += 1; },
      reset: () => { calls.reset += 1; }
    },
    filtering: {
      setFilter: filter => calls.setFilter.push(filter),
      clearFilter: () => { calls.clearFilter += 1; }
    },
    refresh: () => { calls.refresh += 1; },
    openDatasetItem: reference => calls.opened.push(reference)
  };
  return { ds, calls };
}

// parameters adds input properties by name ({ completedStatusValues: "5" }); offsetMinutes is the Dynamics user zone.
function makeContext(ds, { licenseKey = "", allocatedWidth = 1200, parameters = {}, offsetMinutes, utils } = {}) {
  return {
    parameters: { tasks: ds, licenseKey: { raw: licenseKey }, ...Object.fromEntries(Object.entries(parameters).map(([name, raw]) => [name, { raw }])) },
    mode: { allocatedWidth, allocatedHeight: 600, trackContainerResize() {} },
    factory: { requestRender() {} },
    webAPI: {},
    ...(offsetMinutes === undefined ? {} : { userSettings: { getTimeZoneOffsetMinutes: () => offsetMinutes } }),
    ...(utils ? { utils } : {})
  };
}

function installWindowStub() {
  global.window = {
    location: { origin: "https://contoso.crm4.dynamics.com" },
    parent: undefined,
    localStorage: undefined,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: callback => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout
  };
}

module.exports = { TASK_COLUMNS, CUSTOM_COLUMNS, HIERARCHY_COLUMNS, PROJECT_TASK_COLUMNS, makeDataset, makeContext, installWindowStub };
