import { DateBehavior, toUserCalendarDate } from "./deadline";

export type FieldKey = "title" | "start" | "finish" | "owner" | "status" | "createdOn" | "description" | "parent" | "milestone" | "sequence" | "summary";
export type ColumnLike = { name:string; alias?:string; dataType?:string; displayName?:string };
export type RecordLike = { getValue(columnName:string):unknown; getFormattedValue(columnName:string):string };
// Parent reference read from the mapped lookup. name is only set when Dataverse returned display text for it.
export type ParentRef = { id:string; entityType?:string; name?:string };
// Neutral: completion semantics are not known for the mapping, so no completed, overdue or due-soon styling is applied.
export type TaskStatus = "Active" | "Completed" | "Canceled" | "Neutral";
// Completion comes only from raw values with a known meaning; labels are never interpreted. The standard Task statecode
// is built in; every other mapping uses the configured Status values or a configured progress column.
export type Completion =
  | { kind:"status"; source:"task"|"configured"; column:ColumnLike; completed:string[]; canceled:string[]; open?:string[] }
  | { kind:"progress"; column:ColumnLike; completeAt:number };
export type CompletionConfig = { completedValues?:string|null; canceledValues?:string|null; progressColumn?:string|null; progressCompleteValue?:number|null };
// How each mapped date column is read: its Dataverse behavior and the user's time zone offset for an instant.
export type DateReading = { behaviorOf?:(column:ColumnLike)=>DateBehavior; offsetFor?:(instant:Date)=>number };
export type TaskItem = {
  recordId:string;
  name:string;
  assignedTo:string;
  status:TaskStatus;
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
  completion?:Completion;
  // Set when the completion settings are invalid; rows are then Neutral and the reason is shown.
  completionError?:string;
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
  // Deadline colours and the colour legend need known completion semantics.
  showDeadlines?:boolean;
  showCanceled?:boolean;
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
// Task statecode: Open (0), Completed (1), Canceled (2), verified in sandbox-simetrix metadata (2026-11-18).
const TASK_STATECODE = { completed: ["1"], canceled: ["2"], open: ["0"] };
const NUMERIC_TYPES = ["whole.none", "decimal", "fp", "currency"];

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
  showDescription: false,
  showDeadlines: true,
  showCanceled: true
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

// Comma or semicolon separated raw choice values, for example "1" or "192350001; 192350002". undefined when invalid.
export function parseRawValues(text:string|null|undefined):string[]|undefined {
  const parts = (text ?? "").split(/[,;]/).map(part => part.trim()).filter(Boolean);
  if (!parts.length) return [];
  return parts.every(part => /^-?\d+$/.test(part)) ? Array.from(new Set(parts.map(part => String(Number(part))))) : undefined;
}

// Explicit settings win: a progress column, then configured Status values, then the built-in Task statecode.
export function resolveCompletion(columns:Partial<Record<FieldKey,ColumnLike>>, allColumns:ColumnLike[], isTaskTable:boolean, config:CompletionConfig = {}):{ completion?:Completion; error?:string } {
  const progressName = (config.progressColumn ?? "").trim().toLowerCase();
  if (progressName) {
    const column = allColumns.find(candidate => candidate.name.toLowerCase() === progressName);
    if (!column) return { error: `Deadline colours are off: the progress column ${progressName} is not in this view.` };
    if (!NUMERIC_TYPES.includes((column.dataType ?? "").toLowerCase())) return { error: `Deadline colours are off: ${column.displayName || progressName} is not a number column.` };
    const completeAt = config.progressCompleteValue === null || config.progressCompleteValue === undefined ? 100 : Number(config.progressCompleteValue);
    if (!Number.isFinite(completeAt) || completeAt <= 0) return { error: "Deadline colours are off: the Completed progress value must be greater than 0." };
    return { completion: { kind: "progress", column, completeAt } };
  }
  const completed = parseRawValues(config.completedValues);
  const canceled = parseRawValues(config.canceledValues);
  if (!completed || !canceled) return { error: "Deadline colours are off: Completed and Canceled status values must be whole numbers separated by commas." };
  if (completed.length || canceled.length) {
    if (!columns.status) return { error: "Deadline colours are off: status values are configured but no Status column is mapped." };
    if (!completed.length) return { error: "Deadline colours are off: set the Completed status values as well as the Canceled ones." };
    const overlap = completed.filter(value => canceled.includes(value));
    if (overlap.length) return { error: `Deadline colours are off: ${overlap.join(", ")} is configured as both Completed and Canceled.` };
    return { completion: { kind: "status", source: "configured", column: columns.status, completed, canceled } };
  }
  if (isTaskTable && columns.status?.name === "statecode") return { completion: { kind: "status", source: "task", column: columns.status, ...TASK_STATECODE } };
  return {};
}

export function resolveFieldMap(columns:ColumnLike[], entityType?:string|null, config?:CompletionConfig):FieldMap {
  const isTaskTable = isStandardTaskTable(entityType);
  const isProjectTask = isProjectTaskTable(entityType);
  const defaults = tableDefaults(entityType);
  const resolved:Partial<Record<FieldKey,ColumnLike>> = {};
  FIELD_KEYS.forEach(key => {
    const column = resolveColumn(columns, key, defaults);
    if (column) resolved[key] = column;
  });
  const { completion, error } = resolveCompletion(resolved, columns, isTaskTable, config);
  const map:FieldMap = {
    isTaskTable,
    columns: resolved,
    ...(completion ? { completion } : {}),
    ...(error ? { completionError: error } : {})
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
// Date and Time values become the calendar day in the browser's zone; mapRecord uses the user's Dynamics zone instead.
export function toCalendarDate(raw:unknown, dateOnly:boolean):Date|null {
  return toUserCalendarDate(raw, dateOnly ? "dateOnly" : "userLocal");
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

// Status comes only from known raw values. Without them the mapped status is displayed as returned and the row is Neutral.
// With status values, every other value of the column is open (Active); with a progress column, any value below the
// Completed value is Active. An empty value is never interpreted.
export function statusOf(raw:unknown, completion?:Completion):TaskStatus {
  if (!completion || raw === null || raw === undefined || raw === "") return "Neutral";
  if (completion.kind === "progress") {
    const progress = typeof raw === "number" ? raw : Number(raw);
    return !Number.isFinite(progress) ? "Neutral" : progress >= completion.completeAt ? "Completed" : "Active";
  }
  if (typeof raw !== "number" && typeof raw !== "string") return "Neutral";
  const value = String(raw).trim();
  if (completion.completed.includes(value)) return "Completed";
  if (completion.canceled.includes(value)) return "Canceled";
  // A built-in mapping lists its open values; configured values make every other option open.
  return (completion.open ? completion.open.includes(value) : /^-?\d+$/.test(value)) ? "Active" : "Neutral";
}

export function dateBehaviorOf(column:ColumnLike):DateBehavior {
  return isDateOnlyColumn(column) ? "dateOnly" : "userLocal";
}

export function mapRecord(recordId:string, record:RecordLike, map:FieldMap, reading:DateReading = {}):TaskItem {
  const { columns, isTaskTable, completion } = map;
  const value = (column?:ColumnLike) => column ? record.getValue(column.name) : null;
  const formatted = (column?:ColumnLike) => column ? record.getFormattedValue(column.name) || "" : "";
  const behaviorOf = reading.behaviorOf ?? dateBehaviorOf;
  // Every date is the calendar day in the user's Dynamics time zone, so bars, colours and filters agree.
  const date = (column?:ColumnLike) => column ? toUserCalendarDate(value(column), isDateOnlyColumn(column) ? "dateOnly" : behaviorOf(column), reading.offsetFor) : null;

  // The status text is always Dataverse's own (localized) label; only the raw value decides the state.
  const statusLabel = formatted(columns.status);
  const status = statusOf(value(completion?.column ?? columns.status), completion);

  const item:TaskItem = {
    recordId,
    name: formatted(columns.title) || (isTaskTable ? "(Unnamed task)" : "(No title)"),
    assignedTo: columns.owner ? formatted(columns.owner) || "Unassigned" : "",
    status,
    statusLabel,
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
    // The completion filter and deadline colours need known raw values (Task statecode or the completion settings).
    // Other mappings show their status column; metadata-based filtering by status stays available through Filter by.
    showStatusFilter: Boolean(map.completion),
    showDeadlines: Boolean(map.completion),
    showCanceled: map.completion?.kind === "status" && map.completion.canceled.length > 0,
    showCreatedOnFilter: Boolean(columns.createdOn),
    showDescription: Boolean(columns.description)
  };
  if (map.isTaskTable) return { ...TASK_LAYOUT, ...visibility, ...(map.completionError ? { notice: map.completionError } : {}) };

  const label = (column:ColumnLike|undefined, fallback:string) => column?.displayName?.trim() || fallback;
  const title = label(columns.title, "Title");
  const start = label(columns.start, "Start");
  const finish = label(columns.finish, "Finish");
  const missing = map.missingViewColumns ?? [];
  const notice = [
    missing.length ? `Add ${missing.join(", ")} to the view to show the Project Operations hierarchy, summary bars and milestones.` : "",
    map.completionError ?? ""
  ].filter(Boolean).join(" ") || undefined;
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
