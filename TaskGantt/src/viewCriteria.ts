// Search, column filters and record counts, adapted from Modern Smart Grid 2.2.3 (viewCriteria.ts). Criteria are sent to
// Dataverse only through the PCF dataset filtering API and are ANDed with the host's own filter, so every page is
// searched and the saved view, Edit filters and the subgrid relationship stay in force.
type DataSetFilter = ComponentFramework.PropertyHelper.DataSetApi.FilterExpression;
type DataSetCondition = ComponentFramework.PropertyHelper.DataSetApi.ConditionExpression;

export type FilterKind = "text" | "choice" | "date";
export type FilterOperator = "contains" | "equals" | "is" | "on" | "before" | "after";
// label is the display text of a choice value; the condition always uses the raw value.
export type ColumnFilter = { column:string; kind:FilterKind; operator:FilterOperator; value:string; label?:string };
export type GanttCriteria = { search:string; filters:ColumnFilter[] };
export type ChoiceOption = { value:string; label:string };
// A view column that may be filtered. options is undefined while a choice column's metadata is loading.
export type FilterColumn = { name:string; label:string; kind:FilterKind; options?:ChoiceOption[]; optionsError?:string };
export type SearchState = { label?:string; error?:string };
export type MatchingTotal = number | "capped" | undefined;

export const EMPTY_CRITERIA:GanttCriteria = { search: "", filters: [] };
export const TOTAL_COUNT_CAP = 5000;
export const FILTER_OPERATORS:Record<FilterKind,{ value:FilterOperator; label:string }[]> = {
  text: [{ value: "contains", label: "Contains" }, { value: "equals", label: "Equals" }],
  choice: [{ value: "is", label: "Is" }],
  date: [{ value: "on", label: "On" }, { value: "before", label: "Before" }, { value: "after", label: "After" }]
};

// Microsoft.Xrm.Sdk.Query.ConditionOperator values listed as supported by the PCF typings.
const CONDITION = { equal: 0, like: 6, on: 25, onOrBefore: 26, onOrAfter: 27 } as const;

export function filterKind(dataType:string|undefined):FilterKind|undefined {
  const type = (dataType || "").toLowerCase();
  if (type === "dateandtime.dateonly" || type === "dateandtime.dateandtime") return "date";
  if (/^singleline\.(text|email|phone|url|ticker|textarea)$/.test(type) || type === "multiple") return "text";
  // Single choice, Status and Status Reason columns.
  if (type === "optionset") return "choice";
  return undefined;
}

type MetadataLabel = string | { UserLocalizedLabel?:{ Label?:string } | null; LocalizedLabels?:{ Label?:string }[] } | null | undefined;
const labelText = (label:MetadataLabel):string => typeof label === "string" ? label : label?.UserLocalizedLabel?.Label || label?.LocalizedLabels?.[0]?.Label || "";

// Choice options from host metadata. Model-driven hosts return { "0": { text: "Open", value: 0 } } (verified in
// sandbox-simetrix, 2026-11-18); Web API-shaped metadata returns Options with Label.UserLocalizedLabel. The value is
// always the raw option value and the label is Dataverse's localized text; nothing is hardcoded or inferred.
export function choiceOptionsFromMetadata(optionSet:unknown):ChoiceOption[] {
  if (!optionSet || typeof optionSet !== "object") return [];
  const set = optionSet as { Options?:unknown[] } & Record<string,unknown>;
  const entries:unknown[] = Array.isArray(set.Options) ? set.Options
    : Array.isArray(optionSet) ? optionSet as unknown[]
    : Object.entries(set).filter(([key]) => /^-?\d+$/.test(key)).map(([key, entry]) => typeof entry === "string" ? { value: Number(key), text: entry } : { value: Number(key), ...(entry as object) });
  const options:ChoiceOption[] = [];
  entries.forEach(entry => {
    const option = entry as { Value?:unknown; value?:unknown; Label?:MetadataLabel; label?:MetadataLabel; text?:unknown };
    const raw = option.Value ?? option.value;
    if (raw === null || raw === undefined || !/^-?\d+$/.test(String(raw))) return;
    const value = String(Number(raw));
    const label = (typeof option.text === "string" ? option.text : "") || labelText(option.Label) || labelText(option.label);
    if (!options.some(existing => existing.value === value)) options.push({ value, label: label || value });
  });
  return options;
}

export function isDateValue(value:string):boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function shiftDate(value:string, days:number):string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// FetchXML like-pattern: user text is literal, so its wildcard characters are bracket-escaped.
export function containsPattern(text:string):string {
  return `%${text.replace(/[[%_]/g, character => `[${character}]`)}%`;
}

const validValue = (filter:ColumnFilter) => filter.kind === "date" ? isDateValue(filter.value) : filter.kind === "choice" ? /^-?\d+$/.test(filter.value) : Boolean(filter.value);

// One filter per column, trimmed and in a stable order.
export function normalizeCriteria(criteria:GanttCriteria):GanttCriteria {
  const byColumn = new Map<string,ColumnFilter>();
  criteria.filters
    .map(filter => ({ ...filter, value: filter.value.trim() }))
    .filter(validValue)
    .forEach(filter => byColumn.set(filter.column, filter));
  const filters = Array.from(byColumn.values()).sort((a, b) => a.column.localeCompare(b.column));
  return { search: criteria.search.trim(), filters };
}

export function criteriaKey(criteria:GanttCriteria):string {
  const normalized = normalizeCriteria(criteria);
  return JSON.stringify([normalized.search, normalized.filters.map(filter => [filter.column, filter.operator, filter.value])]);
}

export function hasCriteria(criteria:GanttCriteria):boolean {
  const normalized = normalizeCriteria(criteria);
  return Boolean(normalized.search) || normalized.filters.length > 0;
}

export function hasFilterContent(filter:DataSetFilter|null|undefined):boolean {
  return Boolean(filter) && (((filter as DataSetFilter).conditions?.length ?? 0) > 0 || ((filter as DataSetFilter).filters ?? []).some(hasFilterContent));
}

export function cloneFilter(filter:DataSetFilter|null|undefined):DataSetFilter|null {
  return hasFilterContent(filter) ? JSON.parse(JSON.stringify(filter)) as DataSetFilter : null;
}

const conditionKey = (condition:DataSetCondition):string => JSON.stringify([String(condition.attributeName).toLowerCase(), Number(condition.conditionOperator),
  (Array.isArray(condition.value) ? condition.value : [condition.value ?? ""]).map(String), condition.entityAliasName || ""]);

// Canonical form for comparing filters despite property order, empty parts or value shape returned by a host.
export function filterKey(filter:DataSetFilter|null|undefined):string {
  if (!filter || !hasFilterContent(filter)) return "";
  return JSON.stringify([filter.filterOperator === 1 ? 1 : 0, (filter.conditions ?? []).map(conditionKey).sort(),
    (filter.filters ?? []).map(filterKey).filter(Boolean).sort()]);
}

// What the Gantt last wrote: the full expression, the host filter inside it and the Gantt's own conditions.
export type AppliedFilter = { expression:DataSetFilter; host:DataSetFilter|null; own:DataSetCondition[] };

function replaceSubtree(filter:DataSetFilter, key:string, replacement:DataSetFilter|null):{ filter:DataSetFilter|null; found:boolean } {
  if (filterKey(filter) === key) return { filter: replacement, found: true };
  let found = false;
  const filters = (filter.filters ?? []).flatMap(child => {
    if (found) return [child];
    const result = replaceSubtree(child, key, replacement);
    found = result.found;
    return result.filter ? [result.filter] : [];
  });
  return { filter: { ...filter, filters }, found };
}

// Derives the host's current filter from what the host now reports, removing exactly what the Gantt added. Returns
// "lost" when the Gantt's own conditions are no longer recognisable: the host replaced or rewrote them, and no filter
// can be written safely from a guess.
export function currentHostFilter(current:DataSetFilter|null|undefined, applied:AppliedFilter|undefined):{ host:DataSetFilter|null } | "lost" {
  if (!applied) return { host: cloneFilter(current) };
  const now = cloneFilter(current);
  if (!now) return "lost";
  const expressionKey = filterKey(applied.expression);
  if (filterKey(now) === expressionKey) return { host: cloneFilter(applied.host) };
  // The host wrapped the Gantt's expression inside its own filter.
  const wrapped = replaceSubtree(now, expressionKey, cloneFilter(applied.host));
  if (wrapped.found) return { host: cloneFilter(wrapped.filter) };
  // The host changed conditions beside the Gantt's own, which are still present at the top level.
  if (now.filterOperator !== 1) {
    const remaining = [...(now.conditions ?? [])];
    for (const own of applied.own) {
      const index = remaining.findIndex(condition => conditionKey(condition) === conditionKey(own));
      if (index < 0) return "lost";
      remaining.splice(index, 1);
    }
    return { host: cloneFilter({ ...now, conditions: remaining }) };
  }
  return "lost";
}

// Day operators use Dataverse's own Date Only, user-local and time-zone-independent semantics for the column.
export function conditionFor(filter:ColumnFilter):DataSetCondition {
  const base = { attributeName: filter.column };
  switch (filter.operator) {
    case "contains": return { ...base, conditionOperator: CONDITION.like, value: containsPattern(filter.value) };
    case "equals": return { ...base, conditionOperator: CONDITION.equal, value: filter.value };
    case "is": return { ...base, conditionOperator: CONDITION.equal, value: filter.value };
    case "on": return { ...base, conditionOperator: CONDITION.on, value: filter.value };
    case "before": return { ...base, conditionOperator: CONDITION.onOrBefore, value: shiftDate(filter.value, -1) };
    case "after": return { ...base, conditionOperator: CONDITION.onOrAfter, value: shiftDate(filter.value, 1) };
  }
}

export function criteriaConditions(criteria:GanttCriteria, searchColumn:string|undefined):DataSetCondition[] {
  const normalized = normalizeCriteria(criteria);
  return [
    ...(normalized.search && searchColumn ? [conditionFor({ column: searchColumn, kind: "text", operator: "contains", value: normalized.search })] : []),
    ...normalized.filters.map(conditionFor)
  ];
}

// The dataset filter for the Gantt's own conditions ANDed with the host filter, or null when it should be cleared.
export function buildFilterExpression(own:DataSetCondition[], hostFilter:DataSetFilter|null):DataSetFilter|null {
  const host = cloneFilter(hostFilter);
  if (!own.length) return host;
  return { filterOperator: 0, conditions: own, filters: host ? [host] : [] };
}

// Load more appends pages, so every record in sortedRecordIds is loaded. A server total is shown only when it is
// consistent with what is loaded and with whether another page exists.
export function matchingTotal(total:unknown, loaded:number, hasNextPage:boolean):MatchingTotal {
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) return undefined;
  if (total >= TOTAL_COUNT_CAP && hasNextPage) return "capped";
  if (total < loaded || (!hasNextPage && total !== loaded) || (hasNextPage && total <= loaded)) return undefined;
  return total;
}

const plural = (count:number, noun:string) => `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;

// visible is only passed when collapsed groups hide loaded records; it never changes the matching total.
export function recordCountText(loaded:number, total:MatchingTotal, visible?:number):string {
  const parts = [`${loaded.toLocaleString()} loaded`];
  if (total === "capped") parts.push(`${TOTAL_COUNT_CAP.toLocaleString()}+ matching records (count limit reached)`);
  else if (total === undefined) parts.push("matching total unavailable");
  else parts.push(plural(total, "matching record"));
  if (visible !== undefined) parts.push(`${visible.toLocaleString()} visible`);
  return parts.join(" · ");
}

export function describeFilter(filter:ColumnFilter, columnLabel:string):string {
  const operator = FILTER_OPERATORS[filter.kind].find(option => option.value === filter.operator)?.label.toLowerCase() ?? filter.operator;
  if (filter.kind === "text") return `${columnLabel} ${operator} “${filter.value}”`;
  if (filter.kind === "choice") return `${columnLabel} is ${filter.label ?? filter.value}`;
  return `${columnLabel} ${operator} ${filter.value}`;
}
