export type FieldKey = "title" | "start" | "finish" | "owner" | "status" | "createdOn" | "description" | "parent" | "milestone" | "sequence" | "summary";
export type ColumnLike = { name:string; alias?:string; dataType?:string; displayName?:string };
export type RecordLike = { getValue(columnName:string):unknown; getFormattedValue(columnName:string):string };
// Parent reference read from the mapped lookup. name is only set when Dataverse returned display text for it.
export type ParentRef = { id:string; entityType?:string; name?:string };
export type TaskItem = {
  recordId:string;
  name:string;
  assignedTo:string;
  status:"Active"|"Completed";
  statusLabel?:string;
  description?:string;
  start:Date|null;
  due:Date|null;
  // Phase 2 fields are only present when the matching column is mapped, so flat configurations are unchanged.
  parent?:ParentRef|null;
  isMilestone?:boolean;
  isSummary?:boolean;
  sequence?:number|null;
};
export type FieldMap = {
  isTaskTable:boolean;
  isProjectTaskTable?:boolean;
  columns:Partial<Record<FieldKey,ColumnLike>>;
  completedRawValue?:string;
  // Project Operations hierarchy columns that are not in the view, so the hierarchy features they drive stay off.
  missingViewColumns?:string[];
};
export type GanttLayout = {
  title:string;
  itemsLabel:string;
  labels:{
    task:string;
    compactTask:string;
    owner:string;
    status:string;
    start:string;
    compactStart:string;
    due:string;
    compactDue:string;
    description:string;
    createdOn:string;
  };
  showOwner:boolean;
  showStatus:boolean;
  showStatusFilter:boolean;
  showCreatedOnFilter:boolean;
  showDescription:boolean;
  notice?:string;
};

const FIELD_KEYS:FieldKey[] = ["title", "start", "finish", "owner", "status", "createdOn", "description", "parent", "milestone", "sequence", "summary"];

// Property-set names are the binding contract with forms that already host the control. Never rename them.
// The summary flag has no property-set: it is only read from a verified table default (Project Operations).
export const PROPERTY_SET_NAMES: Partial<Record<FieldKey,string>> = {
  title: "subject",
  start: "scheduledstart",
  finish: "scheduledend",
  owner: "ownerid",
  status: "statecode",
  createdOn: "createdon",
  description: "description",
  parent: "parent",
  milestone: "milestone",
  sequence: "sequence"
};

const TASK_ENTITY = "task";
const PROJECT_TASK_ENTITY = "msdyn_projecttask";
const TASK_STATECODE_COMPLETED = "1";

// Column names used for the standard Task table when a property-set is not bound. Description is
// intentionally absent so existing Tasks configurations only show it after it is explicitly bound.
const TASK_TABLE_DEFAULTS: Partial<Record<FieldKey,string>> = {
  title: "subject",
  start: "scheduledstart",
  finish: "scheduledend",
  owner: "ownerid",
  status: "statecode",
  createdOn: "createdon"
};

// Project Operations columns verified on msdyn_projecttask (org3b1c1cb9, 2026-11-13). Project Operations keeps rolled-up
// msdyn_start/msdyn_finish on summary tasks, so a summary bar can render before its children are loaded.
const PROJECT_TASK_DEFAULTS: Partial<Record<FieldKey,string>> = {
  title: "msdyn_subject",
  start: "msdyn_start",
  finish: "msdyn_finish",
  parent: "msdyn_parenttask",
  summary: "msdyn_summary",
  milestone: "msdyn_ismilestone",
  sequence: "msdyn_displaysequence"
};

const PROJECT_TASK_VIEW_COLUMN_LABELS: Partial<Record<FieldKey,string>> = {
  parent: "Parent Task",
  summary: "Summary",
  milestone: "Milestone",
  sequence: "Display Sequence"
};

export const TASK_LAYOUT: GanttLayout = {
  title: "Tasks Plan",
  itemsLabel: "tasks",
  labels: {
    task: "Task name",
    compactTask: "Task",
    owner: "Assigned to",
    status: "Status",
    start: "Start Date",
    compactStart: "Start",
    due: "Due Date",
    compactDue: "Due",
    description: "Description",
    createdOn: "Created On"
  },
  showOwner: true,
  showStatus: true,
  showStatusFilter: true,
  showCreatedOnFilter: true,
  showDescription: false
};

const normalizeEntity = (entityType?:string|null) => (entityType ?? "").trim().toLowerCase();

export function isStandardTaskTable(entityType?:string|null):boolean {
  return normalizeEntity(entityType) === TASK_ENTITY;
}

export function isProjectTaskTable(entityType?:string|null):boolean {
  return normalizeEntity(entityType) === PROJECT_TASK_ENTITY;
}

function tableDefaults(entityType?:string|null):Partial<Record<FieldKey,string>> {
  if (isStandardTaskTable(entityType)) return TASK_TABLE_DEFAULTS;
  if (isProjectTaskTable(entityType)) return PROJECT_TASK_DEFAULTS;
  return {};
}

// Explicit bindings win. Table defaults only apply to columns that are already in the view.
export function resolveColumn(columns:ColumnLike[], key:FieldKey, defaults:Partial<Record<FieldKey,string>>):ColumnLike|undefined {
  const propertySet = PROPERTY_SET_NAMES[key];
  const bound = propertySet ? columns.find(column => column.alias === propertySet && column.name) : undefined;
  if (bound) return bound;
  const defaultName = defaults[key];
  return defaultName ? columns.find(column => column.name === defaultName) : undefined;
}

export function resolveFieldMap(columns:ColumnLike[], entityType?:string|null):FieldMap {
  const isTaskTable = isStandardTaskTable(entityType);
  const isProjectTask = isProjectTaskTable(entityType);
  const defaults = tableDefaults(entityType);
  const resolved:Partial<Record<FieldKey,ColumnLike>> = {};
  FIELD_KEYS.forEach(key => {
    const column = resolveColumn(columns, key, defaults);
    if (column) resolved[key] = column;
  });
  const map:FieldMap = {
    isTaskTable,
    columns: resolved,
    completedRawValue: isTaskTable && resolved.status?.name === "statecode" ? TASK_STATECODE_COMPLETED : undefined
  };
  if (isProjectTask) {
    map.isProjectTaskTable = true;
    map.missingViewColumns = (Object.keys(PROJECT_TASK_VIEW_COLUMN_LABELS) as FieldKey[])
      .filter(key => !resolved[key])
      .map(key => PROJECT_TASK_VIEW_COLUMN_LABELS[key] as string);
  }
  return map;
}

export function hasHierarchy(map:FieldMap):boolean {
  return Boolean(map.columns.parent);
}

export function isDateOnlyColumn(column?:ColumnLike):boolean {
  return column?.dataType === "DateAndTime.DateOnly";
}

export function hasDate(value:Date|null|undefined):value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

// Returns null for empty values. Date Only values become local midnight of their calendar day, whether the
// platform supplies them as "yyyy-mm-dd" strings, UTC midnight or local midnight, so they never shift a day.
export function toCalendarDate(raw:unknown, dateOnly:boolean):Date|null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (dateOnly && typeof raw === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  const date = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw as string | number);
  if (!hasDate(date)) return null;
  if (!dateOnly) return date;
  const isUtcMidnight = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  return isUtcMidnight
    ? new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    : new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isCompletedLabel(label:string):boolean {
  return label.trim().toLowerCase() === "completed";
}

export function normalizeId(id:string):string {
  return id.trim().replace(/[{}]/g, "").toLowerCase();
}

// Lookup values arrive as an entity reference ({ id: { guid } | string, etn | entityType, name }) or a bare id.
// The display name is only taken from text Dataverse returned; nothing is looked up or invented.
export function toParentRef(raw:unknown, formatted:string):ParentRef|null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === null || value === undefined || value === "") return null;
  let id = "";
  let entityType:string|undefined;
  let name:string|undefined;
  if (typeof value === "string") {
    id = value;
  } else if (typeof value === "object") {
    const ref = value as { id?:unknown; etn?:unknown; entityType?:unknown; name?:unknown };
    const refId = ref.id && typeof ref.id === "object" ? (ref.id as { guid?:unknown }).guid : ref.id;
    id = typeof refId === "string" ? refId : "";
    const type = typeof ref.etn === "string" ? ref.etn : typeof ref.entityType === "string" ? ref.entityType : "";
    entityType = type ? type.toLowerCase() : undefined;
    name = typeof ref.name === "string" && ref.name.trim() ? ref.name.trim() : undefined;
  }
  if (!id.trim()) return null;
  const text = name || formatted.trim() || undefined;
  return { id: normalizeId(id), ...(entityType ? { entityType } : {}), ...(text ? { name: text } : {}) };
}

// Two Options values may surface as booleans, 0/1 numbers or "0"/"1" strings depending on the host.
export function toFlag(raw:unknown):boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  if (typeof raw === "string") return raw.trim() === "1" || raw.trim().toLowerCase() === "true";
  return false;
}

export function toSequence(raw:unknown):number|null {
  if (raw === null || raw === undefined || raw === "") return null;
  const number = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(number) ? number : null;
}

export function mapRecord(recordId:string, record:RecordLike, map:FieldMap, completedRawValue?:string):TaskItem {
  const { columns, isTaskTable } = map;
  const value = (column?:ColumnLike) => column ? record.getValue(column.name) : null;
  const formatted = (column?:ColumnLike) => column ? record.getFormattedValue(column.name) || "" : "";
  const date = (column?:ColumnLike) => toCalendarDate(value(column), isDateOnlyColumn(column));

  const statusLabel = formatted(columns.status);
  const rawStatus = value(columns.status);
  const completed = completedRawValue !== undefined && rawStatus !== null && rawStatus !== undefined
    ? String(rawStatus) === completedRawValue
    : isCompletedLabel(statusLabel);
  const status:TaskItem["status"] = completed ? "Completed" : "Active";

  const item:TaskItem = {
    recordId,
    name: formatted(columns.title) || (isTaskTable ? "(Unnamed task)" : "(No title)"),
    assignedTo: columns.owner ? formatted(columns.owner) || "Unassigned" : "",
    status,
    statusLabel: isTaskTable ? status : statusLabel || status,
    description: formatted(columns.description),
    start: date(columns.start) ?? (isTaskTable ? date(columns.createdOn) : null),
    due: date(columns.finish)
  };
  if (columns.parent) item.parent = toParentRef(value(columns.parent), formatted(columns.parent));
  if (columns.milestone) item.isMilestone = toFlag(value(columns.milestone));
  if (columns.summary) item.isSummary = toFlag(value(columns.summary));
  if (columns.sequence) item.sequence = toSequence(value(columns.sequence));
  return item;
}

export function buildLayout(map:FieldMap):GanttLayout {
  const { columns } = map;
  const visibility = {
    showOwner: Boolean(columns.owner),
    showStatus: Boolean(columns.status),
    // Custom tables have no known Completed value until one can be configured explicitly, so the status
    // column is shown but the completion filter is deferred.
    showStatusFilter: Boolean(columns.status) && map.isTaskTable,
    showCreatedOnFilter: Boolean(columns.createdOn),
    showDescription: Boolean(columns.description)
  };
  if (map.isTaskTable) return { ...TASK_LAYOUT, ...visibility };

  const label = (column:ColumnLike|undefined, fallback:string) => column?.displayName?.trim() || fallback;
  const title = label(columns.title, "Title");
  const start = label(columns.start, "Start");
  const finish = label(columns.finish, "Finish");
  const missing = map.missingViewColumns ?? [];
  const notice = missing.length
    ? `Add ${missing.join(", ")} to the view to show the Project Operations hierarchy, summary bars and milestones.`
    : undefined;
  return {
    title: map.isProjectTaskTable ? "Project Tasks" : "Schedule",
    itemsLabel: map.isProjectTaskTable ? "tasks" : "records",
    ...(notice ? { notice } : {}),
    labels: {
      task: title,
      compactTask: title,
      owner: label(columns.owner, "Owner"),
      status: label(columns.status, "Status"),
      start,
      compactStart: start,
      due: finish,
      compactDue: finish,
      description: label(columns.description, "Description"),
      createdOn: label(columns.createdOn, "Created On")
    },
    ...visibility
  };
}
