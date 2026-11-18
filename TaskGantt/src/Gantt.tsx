import * as React from "react";
import { GanttLayout, hasDate, normalizeId, TASK_LAYOUT, TaskItem } from "./fieldMap";
import { Hierarchy, SummarySpan, VisibleRow, visibleRows } from "./hierarchy";
import { describeSkipped, layoutDependencies, representatives, routePath, RowAnchor, stubPath } from "./dependencies";
import type { DependencyView } from "./dependencyLoader";
import { deadlineState, deadlineText, DEFAULT_THRESHOLDS, DeadlineState, DeadlineThresholds } from "./deadline";
import { describeFilter, EMPTY_CRITERIA, FILTER_OPERATORS, FilterColumn, FilterOperator, GanttCriteria, hasCriteria, isDateValue, MatchingTotal, recordCountText, SearchState } from "./viewCriteria";

export type { GanttLayout, TaskItem } from "./fieldMap";
export type StatusFilter = "all" | "active" | "completed" | "overdue";
export type DateFilter = "all" | "thisWeek" | "lastWeek" | "thisMonth" | "lastMonth";
export type SortKey = "task" | "assignedTo" | "startDate" | "dueDate";
export type SortDirection = "asc" | "desc";
export type SortState = { key:SortKey; direction:SortDirection } | undefined;
export type ScheduleState = "scheduled" | "unscheduled" | "reversed";
export type LicenseState = "checking" | "licensed" | "unlicensed" | "error";
export type LicenseDebugInfo = {
  endpoint:string;
  request:{
    organizationId:string;
    environmentUrl:string;
    controlCode:string;
    licenseKey:string;
    version:string;
  };
  response?:{
    licensed?:boolean;
    reason?:string;
    licenseMode?:string;
    expiresOn?:string;
    status?:string;
    error?:string;
    cacheUsed?:boolean;
    cacheSource?:"localStorage"|"dataverse"|"azure";
    validationStartedAt?:string;
    validationFinishedAt?:string;
    durationMs?:number;
  };
};
export const CONTROL_VERSION = "3.7.1";

export type TaskFilters = {
  status: StatusFilter;
  createdOn: DateFilter;
  dueDate: DateFilter;
};

type Props = {
  tasks:TaskItem[];
  // The user's current calendar day in the Dynamics time zone (local midnight); the browser's day when absent.
  today?:Date;
  thresholds?:DeadlineThresholds;
  // Present only when a Parent column is mapped; without it the rows render flat exactly as before.
  hierarchy?:Hierarchy;
  // Present only when a link source applies (Project Operations or a configured link table).
  dependencies?:DependencyView;
  pageSize?:number;
  layout?:GanttLayout;
  allocatedHeight:number;
  allocatedWidth:number;
  loading:boolean;
  filters:TaskFilters;
  // Search and column filters; absent in hosts or tests that do not offer them.
  criteria?:GanttCriteria;
  filterColumns?:FilterColumn[];
  search?:SearchState;
  // Mapped field keys (title, start, finish, ...) whose column is filtered, for header indicators.
  filteredFields?:string[];
  criteriaNotice?:string;
  // Dataset records only; updating is set while a request runs and the previous count is shown.
  recordCount?:{ loaded:number; total:MatchingTotal; updating:boolean };
  onCriteriaChange?:(criteria:GanttCriteria)=>void;
  onClearAll?:()=>void;
  sorting:SortState;
  licenseState:LicenseState;
  licenseMessage:string;
  licenseDebugInfo?:LicenseDebugInfo;
  onRevalidateLicense:()=>void;
  onFiltersChange:(filters:TaskFilters)=>void;
  onSortChange:(sorting:SortState)=>void;
  onRefresh:()=>void;
  onOpen:(id:string)=>void;
  onLoadMore?:()=>void;
  refreshDisabled:boolean;
  refreshing:boolean;
  instanceId:string;
};

// Bar and diamond colour class: deadline level for Active rows, otherwise the known state or neutral.
export type BarTone = "scheduled" | "approaching" | "near" | "imminent" | "overdue" | "completed" | "canceled" | "neutral";
const DAY = 86400000;
const clamp = (value:number,min:number,max:number) => Math.min(max,Math.max(min,value));
const startOfDay = (d:Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d:Date,n:number) => new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);
const fmt = (d:Date) => d.toLocaleDateString(undefined,{day:"2-digit",month:"short",year:"numeric"});

export function sortTasksForDisplay(tasks:TaskItem[], sorting:SortState):TaskItem[] {
  if (!sorting) return tasks;
  const direction = sorting.direction === "asc" ? 1 : -1;
  return tasks
    .map((task,index)=>({task,index,value:getSortValue(task,sorting.key)}))
    .sort((a,b)=>{
      const aNull = a.value === null;
      const bNull = b.value === null;
      if (aNull && bNull) return a.index - b.index;
      if (aNull) return 1;
      if (bNull) return -1;
      const result = typeof a.value === "number" && typeof b.value === "number"
        ? a.value - b.value
        : String(a.value).localeCompare(String(b.value), undefined, {sensitivity:"base", numeric:true});
      return result === 0 ? a.index - b.index : result * direction;
    })
    .map(item=>item.task);
}

function getSortValue(task:TaskItem,key:SortKey):string|number|null {
  if (key === "task") return normalizeText(task.name);
  if (key === "assignedTo") return normalizeText(task.assignedTo);
  const date = key === "startDate" ? task.start : task.due;
  return hasDate(date) ? date.getTime() : null;
}

export function getScheduleState(task:TaskItem):ScheduleState {
  if (!hasDate(task.start) || !hasDate(task.due)) return "unscheduled";
  return task.due < task.start ? "reversed" : "scheduled";
}

function normalizeText(value:string):string|null {
  const normalized = value.trim().toLocaleLowerCase();
  return normalized ? normalized : null;
}

// Every layer now lives inside the control's own element. This only removes a version note that 3.7.0 and earlier
// attached to document.body, in case one is left on the page when the control is destroyed.
export function cleanupTaskGanttOverlays(instanceId:string):void {
  if (typeof document === "undefined") return;
  const legacy = document.getElementById(`tg-info-overlay-${instanceId}`);
  if (legacy?.parentElement === document.body) legacy.remove();
}

// The single deadline calculation for a row (colours, icon, tooltips); the server-side overdue filter uses the same day rule.
export function rowDeadline(task:TaskItem, today:Date, thresholds:DeadlineThresholds = DEFAULT_THRESHOLDS):DeadlineState|undefined {
  return deadlineState(task.status, task.due, today, thresholds);
}

export function barTone(task:TaskItem, deadline:DeadlineState|undefined):BarTone {
  if (deadline) return deadline.level;
  return task.status === "Completed" ? "completed" : task.status === "Canceled" ? "canceled" : task.status === "Active" ? "scheduled" : "neutral";
}

const fmtOptional = (d:Date|null) => hasDate(d) ? fmt(d) : "\u2014";

const MAX_INDENT_LEVELS = 8;
const INDENT_PX = 16;
const NO_COLLAPSED:ReadonlySet<string> = new Set<string>();

// A milestone sits on its Finish date, or on Start when Finish is empty.
export function milestoneDate(task:TaskItem):Date|null {
  if (task.isMilestone !== true) return null;
  return hasDate(task.due) ? task.due : hasDate(task.start) ? task.start : null;
}

export function summaryTitle(name:string, span:SummarySpan):string {
  const range = `${fmt(span.start)} - ${fmt(span.end)}`;
  if (!span.derived) return `${name}: ${range}`;
  const children = `${span.loadedChildCount} loaded child row${span.loadedChildCount === 1 ? "" : "s"}`;
  return `${name}: ${range} (from ${children}; may be incomplete)`;
}

type TipHandlers = { show:(target:HTMLElement,text:string)=>void; hide:()=>void };

// Overdue tasks only. Focusable so keyboard users get the same "Overdue by N days" tooltip as hover; the text is also
// the accessible name.
const OverdueIndicator: React.FC<{deadline:DeadlineState|undefined;tip:TipHandlers}> = ({deadline,tip}) => {
  if (deadline?.level !== "overdue") return null;
  const label = deadlineText(deadline);
  return <span className="tg-urgency overdue" role="img" tabIndex={0} aria-label={label}
    onMouseEnter={event=>tip.show(event.currentTarget,label)} onMouseLeave={tip.hide}
    onFocus={event=>tip.show(event.currentTarget,label)} onBlur={tip.hide}>
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="7"/><path d="M8 3.8v5.4M8 11.8h.01"/></svg>
  </span>;
};

type FilterEditor = { column:string; operator:FilterOperator; value:string; error?:string };

export const Gantt: React.FC<Props> = ({tasks,today:todayProp,thresholds = DEFAULT_THRESHOLDS,hierarchy,dependencies,pageSize = 10,layout = TASK_LAYOUT,allocatedHeight,allocatedWidth,loading,filters,criteria = EMPTY_CRITERIA,filterColumns = [],search,filteredFields = [],criteriaNotice,recordCount,onCriteriaChange,onClearAll,sorting,licenseState,licenseMessage,onRevalidateLicense,onFiltersChange,onSortChange,onRefresh,onOpen,onLoadMore,refreshDisabled,refreshing,instanceId}) => {
  const rootRef = React.useRef<HTMLElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const filterButtonRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  // One tooltip for the control, positioned inside it, for hover and keyboard focus. It follows its icon while the rows
  // scroll (focus scrolls the icon into view) and is hidden while the icon is outside the visible rows.
  const [tip,setTip] = React.useState<{text:string;left:number;top:number}|undefined>(undefined);
  const tipTarget = React.useRef<{element:HTMLElement;text:string}|null>(null);
  const placeTip = () => {
    const root = rootRef.current, scroll = scrollRef.current, target = tipTarget.current;
    if (!root || !scroll || !target) return;
    const rect = target.element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const head = scroll.querySelector(".tg-head")?.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    if (rect.top < (head ? head.bottom : scrollRect.top) - 1 || rect.bottom > scrollRect.bottom + 1) { setTip(undefined); return; }
    const below = rect.bottom - rootRect.top + 6;
    setTip({text:target.text, left:clamp(rect.left - rootRect.left + rect.width/2, 70, Math.max(70, rootRect.width - 70)), top: below + 30 > rootRect.height ? rect.top - rootRect.top - 30 : below});
  };
  const tipHandlers:TipHandlers = {
    show: (element,text) => { tipTarget.current = {element,text}; placeTip(); },
    hide: () => { tipTarget.current = null; setTip(undefined); }
  };
  const todayRef = React.useRef<HTMLElement>(null);
  const infoButtonRef = React.useRef<HTMLButtonElement>(null);
  const positionedSignatures = React.useRef<Record<string,string>>({});
  const lastTimelineSignature = React.useRef("");
  const [infoOpen,setInfoOpen] = React.useState(false);
  // Collapsed rows live with this control instance, so they survive refresh and Load more.
  const [collapsed,setCollapsed] = React.useState<ReadonlySet<string>>(NO_COLLAPSED);
  const overlayId = `tg-info-overlay-${instanceId}`;
  const toggleRow = (recordId:string) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(recordId)) next.delete(recordId); else next.add(recordId);
    return next;
  });
  const rows:VisibleRow[]|undefined = hierarchy ? visibleRows(hierarchy, collapsed) : undefined;
  // Every hierarchy row, collapsed or not, so collapsing never shrinks or shifts the timeline.
  const allRows:VisibleRow[] = hierarchy ? visibleRows(hierarchy, NO_COLLAPSED) : [];
  // Dependency lines start on whenever a link source applies; the toolbar toggle hides them for this instance.
  const [showDependencies,setShowDependencies] = React.useState(true);
  const rowsRef = React.useRef<HTMLDivElement>(null);
  // Measured vertical centre of each rendered row (rows with a parent note are taller than 46px).
  const [rowCenters,setRowCenters] = React.useState<number[]>([]);

  const changeFilters = (nextFilters:TaskFilters) => {
    scrollRef.current?.scrollTo({top:0,left:0,behavior:"auto"});
    onFiltersChange(nextFilters);
  };
  // Search and column filters run on the server; the draft and the open editor are local until applied.
  const [searchDraft,setSearchDraft] = React.useState(criteria.search);
  React.useEffect(() => setSearchDraft(criteria.search), [criteria.search]);
  const [editor,setEditor] = React.useState<FilterEditor|undefined>(undefined);
  const editorOpen = Boolean(editor);
  React.useEffect(() => {
    if (!editorOpen || typeof document === "undefined") return undefined;
    popoverRef.current?.querySelector<HTMLElement>("select, input")?.focus();
    const close = (restoreFocus:boolean) => { setEditor(undefined); if (restoreFocus) filterButtonRef.current?.focus(); };
    const onPointer = (event:PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (popoverRef.current?.contains(target) || filterButtonRef.current?.contains(target))) return;
      close(false);
    };
    const onKey = (event:KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(true); } };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onPointer, true); document.removeEventListener("keydown", onKey, true); };
  }, [editorOpen]);
  const changeCriteria = (next:GanttCriteria) => {
    if (!onCriteriaChange) return;
    scrollRef.current?.scrollTo({top:0,left:0,behavior:"auto"});
    setEditor(undefined);
    onCriteriaChange(next);
  };
  const columnLabel = (name:string) => filterColumns.find(column => column.name === name)?.label ?? name;
  const openEditor = (name:string) => {
    const column = filterColumns.find(candidate => candidate.name === name);
    if (!column) return;
    const active = criteria.filters.find(filter => filter.column === name);
    setEditor({ column: name, operator: active?.operator ?? FILTER_OPERATORS[column.kind][0].value, value: active?.value ?? "" });
  };
  const applyEditor = () => {
    const column = editor && filterColumns.find(candidate => candidate.name === editor.column);
    if (!editor || !column) return;
    const value = editor.value.trim();
    const error = !value ? (column.kind === "text" ? "Enter a value." : column.kind === "date" ? "Select a date." : "Select a value.")
      : column.kind === "date" && !isDateValue(value) ? "Enter a valid date." : undefined;
    if (error) { setEditor({ ...editor, error }); return; }
    const label = column.kind === "choice" ? column.options?.find(option => option.value === value)?.label : undefined;
    changeCriteria({ search: criteria.search, filters: [...criteria.filters.filter(filter => filter.column !== column.name), { column: column.name, kind: column.kind, operator: editor.operator, value, ...(label ? { label } : {}) }] });
  };
  const changeSort = (key:SortKey) => {
    const direction:SortDirection = sorting?.key === key && sorting.direction === "asc" ? "desc" : "asc";
    scrollRef.current?.scrollTo({top:scrollRef.current.scrollTop,left:0,behavior:"auto"});
    onSortChange({key,direction});
  };

  const {labels} = layout;
  const datedTasks = tasks.filter(t => getScheduleState(t) !== "unscheduled") as Array<TaskItem & {start:Date;due:Date}>;
  const extraTimes = [
    ...allRows.flatMap(row => row.summary ? [row.summary.start.getTime(), row.summary.end.getTime()] : []),
    ...tasks.map(milestoneDate).filter(hasDate).map(d => d.getTime())
  ];
  const today = startOfDay(todayProp ?? new Date());
  const min = startOfDay(new Date(Math.min(today.getTime(),...datedTasks.map(t=>t.start.getTime()),...extraTimes)));
  const max = startOfDay(new Date(Math.max(today.getTime(),...datedTasks.map(t=>Math.max(t.start.getTime(),t.due.getTime())),...extraTimes)));
  const timelineStart = addDays(min,-1), timelineEnd = addDays(max,1);
  const numberOfDays = Math.max(1,Math.round((timelineEnd.getTime()-timelineStart.getTime())/DAY)+1);
  const dateCells = Array.from({length:numberOfDays},(_,i)=>addDays(timelineStart,i));
  const todayIndex = Math.round((today.getTime()-timelineStart.getTime())/DAY);
  const allocatedWidthNumber = Number(allocatedWidth) || 0;
  const compactMode = allocatedWidthNumber > 0 && allocatedWidthNumber < 1050;
  const compactFallback = compactMode && allocatedWidthNumber < 760;
  const taskNameWidth = compactMode ? (compactFallback ? 190 : 230) : 240;
  const showAssignedColumn = !compactMode && layout.showOwner;
  const showDescriptionColumn = !compactMode && layout.showDescription;
  const assignedToWidth = showAssignedColumn ? 170 : 0;
  const descriptionWidth = showDescriptionColumn ? 220 : 0;
  const statusWidth = !layout.showStatus ? 0 : compactMode ? (compactFallback ? 82 : 90) : 125;
  const startDateWidth = compactMode ? 0 : 115;
  const dueDateWidth = compactMode ? (compactFallback ? 130 : 145) : 115;
  const dayWidth = compactMode ? (compactFallback ? 32 : allocatedWidthNumber < 900 ? 34 : 36) : allocatedWidthNumber < 700 ? 28 : allocatedWidthNumber < 1100 ? 32 : 38;
  const timelineWidth = numberOfDays * dayWidth;
  const grid = [
    "var(--tg-task-name-width)",
    showAssignedColumn && "var(--tg-assigned-to-width)",
    showDescriptionColumn && "var(--tg-description-width)",
    layout.showStatus && "var(--tg-status-width)",
    !compactMode && "var(--tg-start-date-width)",
    "var(--tg-due-date-width)",
    `${timelineWidth}px`
  ].filter(Boolean).join(" ");
  const timelineGrid = `repeat(${numberOfDays}, ${dayWidth}px)`;
  const rootStyle = {
    "--tg-allocated-height": allocatedHeight > 0 ? `${allocatedHeight}px` : "100%",
    "--tg-task-name-width": `${taskNameWidth}px`,
    "--tg-assigned-to-width": `${assignedToWidth}px`,
    "--tg-description-width": `${descriptionWidth}px`,
    "--tg-status-width": `${statusWidth}px`,
    "--tg-start-date-width": `${startDateWidth}px`,
    "--tg-due-date-width": `${dueDateWidth}px`,
    "--tg-assigned-to-left": `${taskNameWidth}px`,
    "--tg-description-left": `${taskNameWidth + assignedToWidth}px`,
    "--tg-status-left": `${taskNameWidth + assignedToWidth + descriptionWidth}px`,
    "--tg-start-date-left": `${taskNameWidth + assignedToWidth + descriptionWidth + statusWidth}px`,
    "--tg-due-date-left": `${taskNameWidth + assignedToWidth + descriptionWidth + statusWidth + startDateWidth}px`
  } as React.CSSProperties;
  const hasToolbarFilters = filters.status !== "all" || filters.createdOn !== "all" || filters.dueDate !== "all";
  const hasSearchOrFilters = hasCriteria(criteria);
  const hasActiveFilters = hasToolbarFilters || hasSearchOrFilters;
  const sortSignature = sorting ? `${sorting.key}:${sorting.direction}` : "default";
  const criteriaSignature = hasSearchOrFilters ? `|${JSON.stringify([criteria.search, criteria.filters.map(filter => [filter.column, filter.operator, filter.value])])}` : "";
  const filterSignature = `${filters.status}|${filters.createdOn}|${filters.dueDate}|${sortSignature}${criteriaSignature}`;
  const layoutMode = compactMode ? "compact" : "detailed";
  const timelineSignature = `${layoutMode}|${timelineStart.getTime()}|${numberOfDays}|${dayWidth}`;

  // The version note is rendered inside the control (3.7.1; 3.7.0 attached it to document.body above every Dynamics
  // dialog). Outside pointer and Escape close it; the listeners exist only while it is open and go with the control.
  React.useEffect(() => {
    if (!infoOpen || typeof document === "undefined") return undefined;
    const button = infoButtonRef.current;
    const closeIfOutside = (event:PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (button?.contains(target) || document.getElementById(overlayId)?.contains(target))) return;
      setInfoOpen(false);
    };
    const closeOnEscape = (event:KeyboardEvent) => {
      if (event.key === "Escape") {
        setInfoOpen(false);
        button?.focus();
      }
    };
    document.addEventListener("pointerdown", closeIfOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [infoOpen, overlayId]);
  const infoPosition = (() => {
    const button = infoButtonRef.current, root = rootRef.current;
    if (!infoOpen || !button || !root) return undefined;
    const rect = button.getBoundingClientRect(), rootRect = root.getBoundingClientRect();
    return { left: Math.max(8, rect.left - rootRect.left - 8), top: rect.bottom - rootRect.top + 8 };
  })();

  const centreToday = (behavior:ScrollBehavior) => {
    const scroll = scrollRef.current;
    const marker = todayRef.current;
    if (!scroll || !marker) return;
    const markerRect = marker.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const stickyCells = Array.from(scroll.querySelectorAll<HTMLElement>(".tg-head .tg-sticky"));
    const measuredFrozenWidth = stickyCells.reduce((total,cell)=>total + cell.getBoundingClientRect().width,0);
    const frozenWidth = Math.min(measuredFrozenWidth, Math.max(0, scroll.clientWidth - dayWidth));
    const visibleTimelineWidth = Math.max(dayWidth, scroll.clientWidth - frozenWidth);
    const markerCenter = markerRect.left - scrollRect.left + scroll.scrollLeft + (markerRect.width / 2);
    const maxLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    scroll.scrollTo({left:clamp(markerCenter - frozenWidth - (visibleTimelineWidth / 2), 0, maxLeft),top:scroll.scrollTop,behavior});
  };

  React.useLayoutEffect(() => {
    if (loading || todayIndex < 0 || todayIndex >= numberOfDays) return;
    const scroll = scrollRef.current;
    const marker = todayRef.current;
    if (!scroll || !marker) return;

    const positionedTimeline = positionedSignatures.current[filterSignature];
    const timelineChanged = lastTimelineSignature.current !== "" && lastTimelineSignature.current !== timelineSignature;
    lastTimelineSignature.current = timelineSignature;

    const isTodayVisible = () => {
      const markerRect = marker.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const stickyCells = Array.from(scroll.querySelectorAll<HTMLElement>(".tg-head .tg-sticky"));
      const measuredFrozenWidth = stickyCells.reduce((total,cell)=>total + cell.getBoundingClientRect().width,0);
      const frozenWidth = Math.min(measuredFrozenWidth, Math.max(0, scroll.clientWidth - dayWidth));
      return markerRect.left >= scrollRect.left + frozenWidth && markerRect.right <= scrollRect.right;
    };

    if (positionedTimeline === timelineSignature) return;
    if (positionedTimeline && timelineChanged && isTodayVisible()) {
      positionedSignatures.current[filterSignature] = timelineSignature;
      return;
    }

    requestAnimationFrame(() => {
      centreToday("auto");
      positionedSignatures.current[filterSignature] = timelineSignature;
    });
  }, [filterSignature, loading, numberOfDays, timelineSignature, todayIndex]);

  // Dependency lines need the real row centres; measure them after layout and only update when they change.
  const rowSignature = `${layoutMode}|${(rows ? rows.map(r=>r.task.recordId) : tasks.map(t=>t.recordId)).join("|")}`;
  React.useLayoutEffect(() => {
    const container = rowsRef.current;
    if (!dependencies || !container) return;
    const centers = Array.from(container.children)
      .filter((child):child is HTMLElement => child instanceof HTMLElement && child.classList.contains("tg-row"))
      .map(row => row.offsetTop + row.offsetHeight / 2);
    setRowCenters(current => current.length === centers.length && current.every((value,index)=>value === centers[index]) ? current : centers);
  }, [rowSignature, Boolean(dependencies), showDependencies, allocatedWidth]);

  const renderTimelineCells = () => dateCells.map((d,i)=><i key={i} className={d.getDay()%6===0?"weekend":""}/>);
  const SORT_FIELDS:Record<SortKey,string> = {task:"title",assignedTo:"owner",startDate:"start",dueDate:"finish"};
  const filterMark = (field:string) => filteredFields.includes(field)
    ? <span className="tg-filter-mark" role="img" aria-label="Filtered" title="Filtered"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 3h12l-4.6 5.4V13l-2.8 1.2V8.4Z"/></svg></span>
    : null;
  const renderSortButton = (label:string,key:SortKey) => {
    const active = sorting?.key === key;
    return <button className="tg-sort" type="button" onClick={()=>changeSort(key)}>
      <span>{label}</span>{active && <i aria-hidden="true">{sorting.direction === "asc" ? "\u25B2" : "\u25BC"}</i>}{filterMark(SORT_FIELDS[key])}
    </button>;
  };
  const renderSortHeader = (label:string,key:SortKey,className:string) => {
    const active = sorting?.key === key;
    const ariaSort = active ? sorting.direction === "asc" ? "ascending" : "descending" : "none";
    return <div className={`tg-hcell tg-sticky ${className}`} role="columnheader" aria-sort={ariaSort}>
      {renderSortButton(label,key)}
    </div>;
  };

  if (licenseState === "checking") {
    return <section className="tg tg-license" style={rootStyle} aria-label="Modern Gantt license validation">
      <div className="tg-license-state">
        <div className="tg-license-title">{licenseMessage === "Revalidating license..." ? "Revalidating license..." : "Validating license..."}</div>
        <div className="tg-license-body">
          {licenseMessage === "Revalidating license..."
            ? "A fresh license check is running and cached results are being bypassed."
            : "The control is checking whether this organization is licensed."}
        </div>
        <div className="tg-license-actions">
          <button className="tg-license-action" type="button" disabled={licenseMessage === "Revalidating license..."} onClick={onRevalidateLicense}>
            {licenseMessage === "Revalidating license..." ? "Revalidating..." : "Revalidate License"}
          </button>
        </div>
      </div>
    </section>;
  }

  if (licenseState === "unlicensed" || licenseState === "error") {
    return <section className="tg tg-license" style={rootStyle} aria-label="Modern Gantt license validation failed">
      <div className="tg-license-state">
        <div className="tg-license-title">License validation failed.</div>
        <div className="tg-license-body">{licenseMessage || "This organization is not licensed for Modern Gantt. Contact support@simetrixconsult.com."}</div>
        <div className="tg-license-actions">
          <button className="tg-license-action" type="button" onClick={onRevalidateLicense}>Revalidate License</button>
        </div>
      </div>
    </section>;
  }

  const items = layout.itemsLabel;
  const rowEntries:Array<{task:TaskItem;row?:VisibleRow}> = rows ? rows.map(row=>({task:row.task,row})) : tasks.map(task=>({task}));
  const dayIndexOf = (d:Date) => Math.max(0,Math.round((startOfDay(d).getTime()-timelineStart.getTime())/DAY));

  // --- Dependency lines (only when a link source applies) ---
  // Anchors use the same geometry as the bars: summary span, milestone diamond, or the scheduled bar.
  const anchorFor = (t:TaskItem,row?:VisibleRow):{start:number|null;end:number|null} => {
    const summary = row?.summary;
    if (summary) return {start:dayIndexOf(summary.start)*dayWidth, end:(dayIndexOf(summary.end)+1)*dayWidth};
    const milestone = milestoneDate(t);
    if (milestone) { const center = dayIndexOf(milestone)*dayWidth+(dayWidth/2); return {start:center-8, end:center+8}; }
    if (getScheduleState(t) !== "scheduled" || !hasDate(t.start) || !hasDate(t.due)) return {start:null,end:null};
    const first = dayIndexOf(t.start);
    const days = Math.max(1,Math.round((startOfDay(t.due).getTime()-startOfDay(t.start).getTime())/DAY)+1);
    return {start:first*dayWidth, end:(first+days)*dayWidth};
  };
  const frozenWidth = taskNameWidth + assignedToWidth + descriptionWidth + statusWidth + startDateWidth + dueDateWidth;
  const centerOf = (rowIndex:number) => rowCenters[rowIndex] ?? rowIndex*46+23;
  const dependencyLayout = dependencies && showDependencies ? layoutDependencies(
    dependencies.links,
    rowEntries.map(({task:t,row},rowIndex):RowAnchor=>({recordId:t.recordId,rowIndex,...anchorFor(t,row)})),
    representatives(hierarchy, tasks.map(t=>t.recordId), collapsed),
    new Map(tasks.map(t=>[normalizeId(t.recordId),t.name]))
  ) : undefined;
  const plural = (n:number,word:string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const dependencyNote = !dependencies ? undefined
    : dependencies.status === "error" ? {
      text: dependencies.errorKind === "noProject" ? "Dependencies unavailable: no project" : dependencies.errorKind === "access" ? "Dependencies unavailable: no access" : "Dependencies unavailable",
      title:`${dependencies.message ?? "The dependency rows could not be read."} Bars and dates are unaffected.`, error:true}
    : dependencies.status === "loading" ? {text:"Loading dependencies…", title:"Reading dependency rows for the loaded tasks.", error:false}
    : (() => {
      const parts:string[] = [], details:string[] = [];
      if (dependencies.unscoped) { parts.push(`${plural(dependencies.unscoped,"task")} without a project`); details.push("Their links are not read because their Project value is empty."); }
      if (dependencyLayout?.notLoaded) { parts.push(`${plural(dependencyLayout.notLoaded,"link")} to rows not loaded`); details.push("One end is filtered out, on a later page or not accessible; Load more reconnects rows from later pages."); }
      if (dependencies.skipped.length) { parts.push(`${plural(dependencies.skipped.length,"link")} skipped`); details.push(`Skipped: ${describeSkipped(dependencies.skipped)}.`); }
      if (dependencyLayout?.unscheduled) { parts.push(`${plural(dependencyLayout.unscheduled,"link")} not drawn`); details.push("A linked task has no bar (missing or invalid dates)."); }
      if (dependencies.truncated) { parts.push("some links not read"); details.push("A batch returned more than 5000 links."); }
      return parts.length ? {text:parts.join(" · "), title:details.join(" "), error:false} : undefined;
    })();
  const markerId = `tg-dep-arrow-${instanceId}`;
  const rowsHeight = rowEntries.length ? centerOf(rowEntries.length-1)+23 : 0;
  const wrapRows = (nodes:React.ReactNode[]) => !dependencies ? nodes : <div className="tg-rows" ref={rowsRef}>
    {nodes}
    {dependencyLayout && (dependencyLayout.lines.length > 0 || dependencyLayout.stubs.length > 0) && <svg className="tg-deps" style={{left:`${frozenWidth}px`,width:`${timelineWidth}px`,height:`${rowsHeight}px`}} role="group" aria-label="Dependency lines">
      <defs><marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 Z"/></marker></defs>
      {dependencyLayout.lines.map(line => <path key={line.key} className={`tg-dep${line.viaCollapsed ? " tg-dep-collapsed" : ""}`} d={routePath(line.x1,centerOf(line.fromRow),line.x2,centerOf(line.toRow),line.fromSide,line.toSide)} markerEnd={`url(#${markerId})`} role="img" aria-label={line.title}><title>{line.title}</title></path>)}
      {dependencyLayout.lines.filter(line => line.count > 1).map(line => <text key={`${line.key}:count`} className="tg-dep-count" x={line.x2 + (line.toSide === "start" ? -14 : 14)} y={centerOf(line.toRow) - 6}>{line.count}</text>)}
      {dependencyLayout.stubs.map(stub => <g key={stub.key} className="tg-dep-stub" role="img" aria-label={stub.title}><title>{stub.title}</title><path d={stubPath(stub.x,centerOf(stub.rowIndex),stub.side)}/><circle cx={stub.x + (stub.side === "end" ? 12 : -12)} cy={centerOf(stub.rowIndex)} r="3"/></g>)}
    </svg>}
  </div>;
  return <section ref={rootRef} className={`tg ${compactMode ? "tg-compact" : "tg-detailed"}`} style={rootStyle} aria-label={layout.title === TASK_LAYOUT.title ? "Tasks Gantt" : `${layout.title} Gantt`}>
    <header className="tg-toolbar">
      <div className="tg-toolbar-row tg-toolbar-top">
        <span className="tg-title"><strong>{layout.title}</strong><button ref={infoButtonRef} className="tg-info" type="button" aria-label={`Task Gantt PCF version ${CONTROL_VERSION}`} aria-expanded={infoOpen} aria-describedby={infoOpen ? overlayId : undefined} onClick={()=>setInfoOpen(open=>!open)}><span aria-hidden="true">i</span></button><button className={`tg-refresh ${refreshing ? "is-refreshing" : ""}`} type="button" title={`Refresh ${items}`} aria-label={`Refresh ${items}`} disabled={refreshDisabled} onClick={onRefresh}>
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M16.9 3.6v4.7h-4.7l1.8-1.8A5.5 5.5 0 0 0 4.5 10H3.2a6.8 6.8 0 0 1 11.7-4.4l2-2Zm-1.4 6.4h1.3A6.8 6.8 0 0 1 5.1 14.4l-2 2v-4.7h4.7L6 13.5a5.5 5.5 0 0 0 9.5-3.5Z"/></svg>
        </button>{recordCount && <span className={`tg-count${recordCount.updating ? " is-updating" : ""}`} role="status" aria-live="polite" title={recordCount.updating ? "Updating the record count" : recordCount.total === undefined ? "Dataverse did not report a reliable total for this view." : undefined}>
          {recordCountText(recordCount.loaded, recordCount.total, rows && rows.length !== tasks.length ? rows.length : undefined)}
        </span>}</span>
        <span className="tg-actions">
          {dependencies && <button type="button" role="switch" className={`tg-deps-toggle${showDependencies ? " selected" : ""}`} aria-checked={showDependencies} title={showDependencies ? "Hide dependency lines" : "Show dependency lines"} onClick={()=>setShowDependencies(visible=>!visible)}><span className="tg-switch" aria-hidden="true"><span/></span>Dependencies</button>}
          {dependencyNote && <span className={`tg-deps-status${dependencyNote.error ? " error" : ""}`} role="status" title={dependencyNote.title}>{dependencyNote.text}</span>}
          {hierarchy && hierarchy.waitingCount>0 && <span className="tg-waiting" title={`These ${items} are shown at the top level because their parent is not in the loaded rows: it may be filtered out, on a later page or not accessible.`}>{hierarchy.waitingCount} without loaded parent</span>}
        </span>
      </div>
      <div className="tg-toolbar-row tg-commands">
        {search?.label && <form className="tg-search" role="search" onSubmit={event=>{ event.preventDefault(); changeCriteria({...criteria,search:searchDraft}); }}>
          <button type="submit" className="tg-search-go" disabled={loading} aria-label={`Search ${search.label}`} title="Search"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="6.8" cy="6.8" r="4.6"/><path d="m10.2 10.2 4 4"/></svg></button>
          <label className="tg-search-field">
            <span className="tg-visually-hidden">Search {search.label}</span>
            <input type="search" value={searchDraft} placeholder={`Search ${search.label}…`} aria-label={`Search ${search.label} (contains)`} onChange={event=>setSearchDraft(event.target.value)}/>
          </label>
          {criteria.search && <button type="button" className="tg-search-clear" disabled={loading} aria-label={`Clear search for ${search.label}`} title="Clear search" onClick={()=>changeCriteria({...criteria,search:""})}>{"✕"}</button>}
        </form>}
        {filterColumns.length > 0 && <span className="tg-popover-anchor">
          <button ref={filterButtonRef} type="button" className={`tg-filter-toggle${criteria.filters.length ? " selected" : ""}`} aria-expanded={Boolean(editor)} aria-haspopup="dialog" aria-controls={editor ? `${instanceId}-filters` : undefined} disabled={loading}
            onClick={()=>editor ? setEditor(undefined) : openEditor((filterColumns.find(column => !criteria.filters.some(filter => filter.column === column.name)) ?? filterColumns[0]).name)}>
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 3h12l-4.6 5.4V13l-2.8 1.2V8.4Z"/></svg>
            {`Filters${criteria.filters.length ? ` (${criteria.filters.length})` : ""}`}
          </button>
          {editor && (() => {
            const column = filterColumns.find(candidate => candidate.name === editor.column);
            if (!column) return null;
            const valueLabel = `${column.label} value`;
            return <div ref={popoverRef} id={`${instanceId}-filters`} className="tg-popover tg-filter-editor" role="dialog" aria-label={`Filter ${column.label}`}>
              <label><span>Column</span>
                <select value={column.name} onChange={event=>openEditor(event.target.value)}>
                  {filterColumns.map(option => <option key={option.name} value={option.name}>{option.label}</option>)}
                </select>
              </label>
              <label><span>Condition</span>
                <select value={editor.operator} disabled={FILTER_OPERATORS[column.kind].length === 1} onChange={event=>setEditor({...editor,operator:event.target.value as FilterOperator,error:undefined})}>
                  {FILTER_OPERATORS[column.kind].map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label><span>Value</span>
                {column.kind === "choice"
                  ? <select value={editor.value} aria-label={valueLabel} disabled={!column.options} onChange={event=>setEditor({...editor,value:event.target.value,error:undefined})}>
                      <option value="">{column.options ? "Select…" : column.optionsError ? "Unavailable" : "Loading…"}</option>
                      {(column.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  : <input type={column.kind === "date" ? "date" : "text"} value={editor.value} aria-label={valueLabel} aria-invalid={Boolean(editor.error)}
                      onChange={event=>setEditor({...editor,value:event.target.value,error:undefined})}
                      onKeyDown={event=>{ if (event.key === "Enter") { event.preventDefault(); applyEditor(); } }}/>}
              </label>
              {(editor.error || column.optionsError) && <span className="tg-filter-error" role="alert">{editor.error ?? column.optionsError}</span>}
              <span className="tg-popover-actions">
                <button type="button" className="tg-apply" disabled={loading} onClick={applyEditor}>Apply</button>
                <button type="button" onClick={()=>{ setEditor(undefined); filterButtonRef.current?.focus(); }}>Cancel</button>
              </span>
            </div>;
          })()}
        </span>}
        {layout.showCreatedOnFilter && <label className="tg-filter">{labels.createdOn}
          <select value={filters.createdOn} onChange={event=>changeFilters({...filters,createdOn:event.target.value as DateFilter})}>
            <option value="all">All dates</option>
            <option value="thisWeek">This week</option>
            <option value="lastWeek">Last week</option>
            <option value="thisMonth">This month</option>
            <option value="lastMonth">Last month</option>
          </select>
        </label>}
        <label className="tg-filter">{labels.due}
          <select value={filters.dueDate} onChange={event=>changeFilters({...filters,dueDate:event.target.value as DateFilter})}>
            <option value="all">All dates</option>
            <option value="thisWeek">This week</option>
            <option value="lastWeek">Last week</option>
            <option value="thisMonth">This month</option>
            <option value="lastMonth">Last month</option>
          </select>
        </label>
        {layout.showStatusFilter && <span className="tg-status-filter" role="group" aria-label="Status filter">
          <button type="button" aria-pressed={filters.status==="all"} className={filters.status==="all" ? "selected" : ""} onClick={()=>changeFilters({...filters,status:"all"})}>All</button>
          <button type="button" aria-pressed={filters.status==="active"} className={filters.status==="active" ? "selected" : ""} onClick={()=>changeFilters({...filters,status:"active"})}>Active</button>
          <button type="button" aria-pressed={filters.status==="completed"} className={filters.status==="completed" ? "selected" : ""} onClick={()=>changeFilters({...filters,status:"completed"})}>Completed</button>
          <button type="button" aria-pressed={filters.status==="overdue"} className={filters.status==="overdue" ? "selected" : ""} onClick={()=>changeFilters({...filters,status:"overdue"})}>Overdue</button>
        </span>}
        {hasActiveFilters && (onClearAll
          ? <button className="tg-clear" type="button" onClick={()=>{ scrollRef.current?.scrollTo({top:0,left:0,behavior:"auto"}); setEditor(undefined); onClearAll(); }}>Clear all filters</button>
          : <button className="tg-clear" type="button" onClick={()=>changeFilters({status:"all",createdOn:"all",dueDate:"all"})}>Clear filters</button>)}
        <button type="button" className="tg-today-button" title="Scroll the timeline to today" onClick={()=>centreToday("instant")}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.8v2.6M10.5 1.8v2.6"/></svg>Today
        </button>
      </div>
      {layout.notice && <span className="tg-notice" role="status">{layout.notice}</span>}
      {(search?.error || hasSearchOrFilters || criteriaNotice) && <div className="tg-criteria">
        {search?.error && <span className="tg-notice" role="status">{search.error}</span>}
        {hasSearchOrFilters && <span className="tg-chips" role="list" aria-label="Active search and filters">
          {criteria.search && search?.label && <span className="tg-chip" role="listitem">{`${search.label} contains “${criteria.search}”`}
            <button type="button" disabled={loading} aria-label={`Clear search: ${search.label} contains “${criteria.search}”`} title="Clear search" onClick={()=>changeCriteria({...criteria,search:""})}>{"✕"}</button></span>}
          {criteria.filters.map(filter => {
            const description = describeFilter(filter, columnLabel(filter.column));
            return <span className="tg-chip" role="listitem" key={filter.column}>
              <button type="button" className="tg-chip-edit" disabled={loading || !filterColumns.some(column => column.name === filter.column)} title={`Edit filter: ${description}`} onClick={()=>openEditor(filter.column)}>{description}</button>
              <button type="button" disabled={loading} aria-label={`Clear filter: ${description}`} title="Clear filter" onClick={()=>changeCriteria({...criteria,filters:criteria.filters.filter(existing => existing.column !== filter.column)})}>{"✕"}</button>
            </span>;
          })}
        </span>}
        {criteriaNotice && <span className="tg-notice" role="status">{criteriaNotice}</span>}
      </div>}
    </header>
    <div ref={scrollRef} className="tg-scroll" onScroll={()=>{ if (tipTarget.current) placeTip(); }}>
      <div className="tg-head" style={{gridTemplateColumns:grid}}>
        {renderSortHeader(compactMode ? labels.compactTask : labels.task,"task","tg-col-task")}
        {showAssignedColumn && renderSortHeader(labels.owner,"assignedTo","tg-col-assigned")}
        {showDescriptionColumn && <div className="tg-hcell tg-sticky tg-col-description" role="columnheader" aria-sort="none">{labels.description}{filterMark("description")}</div>}
        {layout.showStatus && <div className="tg-hcell tg-sticky tg-col-status" role="columnheader" aria-sort="none">{labels.status}{filterMark("status")}</div>}
        {!compactMode && renderSortHeader(labels.start,"startDate","tg-col-start")}
        {compactMode
          ? <div className="tg-hcell tg-sticky tg-col-due tg-schedule-head" role="columnheader" aria-sort={sorting?.key === "startDate" ? (sorting.direction === "asc" ? "ascending" : "descending") : sorting?.key === "dueDate" ? (sorting.direction === "asc" ? "ascending" : "descending") : "none"}>
              {renderSortButton(labels.compactStart,"startDate")}
              {renderSortButton(labels.compactDue,"dueDate")}
            </div>
          : renderSortHeader(labels.due,"dueDate","tg-col-due")}
        <div className="tg-calendar" style={{gridTemplateColumns:timelineGrid}}>
          {dateCells.map((d,i)=><div key={i} className={`${d.getDay()%6===0?"weekend":""}${i===todayIndex?" tg-today-cell":""}`} aria-current={i===todayIndex ? "date" : undefined}><b>{d.getDate()}</b><small>{d.toLocaleDateString(undefined,{weekday:"narrow"})}</small></div>)}
          {todayIndex>=0&&todayIndex<numberOfDays&&<em ref={todayRef} className="tg-today" data-tg-today="true" style={{left:`${todayIndex*dayWidth+(dayWidth/2)}px`}}/>}
        </div>
      </div>
      {!tasks.length && <div className="tg-empty">{loading ? `Loading ${items}...` : hasSearchOrFilters ? `No ${items} match the search and filters` : hasActiveFilters ? `No ${items} match the selected filters` : `No ${items} found.`}</div>}
      {wrapRows(rowEntries.map(({task:t,row})=>{
        const schedule = getScheduleState(t);
        const summary = row?.summary ?? null;
        const milestoneDay = milestoneDate(t);
        // A summary bar or a milestone diamond replaces the plain bar and its date warnings.
        const drawn = Boolean(summary) || Boolean(milestoneDay);
        const invalidDates = !drawn && schedule === "reversed";
        const unscheduled = !drawn && schedule === "unscheduled";
        const reversedText = `${labels.due} is earlier than ${labels.start}`;
        const missingText = `Missing ${[!hasDate(t.start) && labels.start, !hasDate(t.due) && labels.due].filter(Boolean).join(" and ")}`;
        const deadline = rowDeadline(t, today, thresholds);
        const tone = barTone(t, deadline);
        const deadlineNote = deadline && deadline.level !== "scheduled" && hasDate(t.due) ? `${deadlineText(deadline)} \u2014 due ${fmt(t.due)}` : "";
        const range = `${fmtOptional(t.start)} - ${fmtOptional(t.due)}`;
        const startDayIndex = hasDate(t.start) ? Math.max(0,Math.round((startOfDay(t.start).getTime()-timelineStart.getTime())/DAY)) : 0;
        const inclusiveDurationDays = schedule === "scheduled" && hasDate(t.start) && hasDate(t.due) ? Math.max(1,Math.round((startOfDay(t.due).getTime()-startOfDay(t.start).getTime())/DAY)+1) : 0;
        const barLeft = startDayIndex * dayWidth;
        const barWidth = inclusiveDurationDays * dayWidth;
        const barTitle = deadlineNote ? `${t.name}: ${range}. ${deadlineNote}` : `${t.name}: ${range}`;
        const barAriaLabel = barTitle;
        const scheduleAriaLabel = unscheduled
          ? `${t.name} is unscheduled. ${missingText}.`
          : `${t.name} schedule from ${fmtOptional(t.start)} to ${fmtOptional(t.due)}${invalidDates ? `. Invalid dates: ${reversedText}.` : ""}`;
        const summaryText = summary ? summaryTitle(t.name, summary) : "";
        const milestoneText = milestoneDay
          ? `${t.name}: milestone on ${fmt(milestoneDay)}${hasDate(t.start) && hasDate(t.due) && startOfDay(t.start).getTime() !== startOfDay(t.due).getTime() ? ` (${labels.start} ${fmt(t.start)}, ${labels.due} ${fmt(t.due)})` : ""}`
          : "";
        const parentName = t.parent?.name;
        const indent = row ? Math.min(row.depth, MAX_INDENT_LEVELS) * INDENT_PX : 0;
        return <div className={`tg-row${unscheduled ? " tg-row-unscheduled" : ""}${row?.isSummaryRow ? " tg-row-summary" : ""}`} style={{gridTemplateColumns:grid}} key={t.recordId} data-level={row ? row.depth + 1 : undefined}>
          <div className="tg-task-cell tg-sticky tg-col-task" style={row ? {paddingLeft:`calc(clamp(6px, 1vw, 10px) + ${indent}px)`} : undefined}>
            <span className="tg-task-title">{row && (row.hasChildren
              ? <button type="button" className="tg-toggle" aria-expanded={row.expanded} aria-label={`${row.expanded ? "Collapse" : "Expand"} ${t.name}`} title={row.expanded ? "Collapse" : "Expand"} onClick={()=>toggleRow(t.recordId)}><span aria-hidden="true">{row.expanded ? "▾" : "▸"}</span></button>
              : <span className="tg-toggle-spacer" aria-hidden="true"/>)}<button className="tg-link" onClick={()=>onOpen(t.recordId)} title={t.name} aria-label={layout.showOwner ? `${t.name}, owner ${t.assignedTo}` : t.name}>{t.name}</button><OverdueIndicator deadline={deadline} tip={tipHandlers}/></span>
            {row?.parentMissing && <span className="tg-parent-note" title={parentName ? `Parent ${parentName} is not in the loaded rows` : "The parent is not in the loaded rows"}><span aria-hidden="true">{"↳"} </span>{parentName ?? "Parent not loaded"}</span>}
            {compactMode && layout.showOwner && <span className="tg-owner">{t.assignedTo}</span>}
          </div>
          {showAssignedColumn && <div className="tg-sticky tg-col-assigned">{t.assignedTo}</div>}
          {showDescriptionColumn && <div className="tg-sticky tg-col-description"><span className="tg-description" title={t.description}>{t.description}</span></div>}
          {layout.showStatus && <div className="tg-sticky tg-col-status"><span className={`tg-status ${t.status.toLowerCase()}`}>{t.statusLabel || (t.status === "Neutral" ? "" : t.status)}</span></div>}
          {!compactMode && <div className="tg-sticky tg-col-start">{fmtOptional(t.start)}</div>}
          <div className="tg-schedule tg-sticky tg-col-due" aria-label={scheduleAriaLabel}>
            {compactMode
              ? <><span>{fmtOptional(t.start)}</span><span aria-hidden="true">{"\u2192"}</span><span>{fmtOptional(t.due)}</span>{invalidDates && <small>Invalid dates</small>}{unscheduled && <small className="tg-unscheduled-note">Unscheduled</small>}</>
              : <><span>{fmtOptional(t.due)}</span>{unscheduled && <small className="tg-unscheduled-note">Unscheduled</small>}</>}
          </div>
          <div className="tg-track" style={{gridTemplateColumns:timelineGrid}}>
            {renderTimelineCells()}
            {summary
              ? <span className={`tg-summary${summary.derived ? " tg-summary-derived" : ""}`} style={{left:`${dayIndexOf(summary.start)*dayWidth}px`,width:`${(dayIndexOf(summary.end)-dayIndexOf(summary.start)+1)*dayWidth}px`}} title={summaryText} aria-label={summaryText}/>
              : unscheduled
              ? <span className="tg-unscheduled" title={missingText}>Unscheduled</span>
              : invalidDates
              ? <span className="tg-warning" title={reversedText}>Invalid dates</span>
              : milestoneDay
              ? null
              : <span className={`tg-bar ${tone}`} style={{left:`${barLeft}px`,width:`${barWidth}px`}} title={barTitle} aria-label={barAriaLabel}>{t.status==="Completed" ? "\u2713" : ""}</span>}
            {milestoneDay && <span className={`tg-milestone ${tone}`} style={{left:`${dayIndexOf(milestoneDay)*dayWidth+(dayWidth/2)}px`}} title={deadlineNote ? `${milestoneText}. ${deadlineNote}` : milestoneText} aria-label={deadlineNote ? `${milestoneText}. ${deadlineNote}` : milestoneText}/>}
            {todayIndex>=0&&todayIndex<numberOfDays&&<em className="tg-today" style={{left:`${todayIndex*dayWidth+(dayWidth/2)}px`}}/>}
          </div>
        </div>}))}
    </div>
    <footer className="tg-footer">
      {layout.showDeadlines
        ? <span className="tg-legend" role="list" aria-label="Colour legend">
            <span role="listitem"><i className="scheduled" aria-hidden="true"/>Scheduled</span>
            <span role="listitem" title={`Yellow from ${thresholds.approaching} days before ${labels.due}, orange from ${thresholds.near}, dark orange from ${thresholds.imminent} (0 is the due day)`}><i className="approaching" aria-hidden="true"/><i className="near" aria-hidden="true"/><i className="imminent" aria-hidden="true"/>Due soon</span>
            <span role="listitem"><i className="overdue" aria-hidden="true"/>Overdue</span>
            <span role="listitem"><i className="completed" aria-hidden="true"/>Completed</span>
            {layout.showCanceled && <span role="listitem"><i className="canceled" aria-hidden="true"/>Canceled</span>}
            {hierarchy && <span role="listitem"><i className="summary" aria-hidden="true"/>Summary</span>}
          </span>
        : <span className="tg-legend-off" title="Set the Completed status values or a progress column in the control properties to colour bars by deadline. Status labels are never used to decide completion.">Deadline colours off: completion not configured</span>}
      <span className="tg-footer-center">
        {onLoadMore && <button type="button" className="tg-more" title={`Load the next ${pageSize} ${items}`} aria-label={`Load the next ${pageSize} ${items}`} disabled={loading} onClick={onLoadMore}>Load more</button>}
      </span>
      <span className="tg-footer-end">
        {tasks.length>10 && <button type="button" className="tg-top" title={`Return to the first ${items}`} aria-label={`Return to the first ${items}`} onClick={()=>scrollRef.current?.scrollTo({top:0,behavior:"smooth"})}>{"↑"}</button>}
      </span>
    </footer>
    {tip && <div className="tg-tip" role="tooltip" style={{left:`${tip.left}px`,top:`${tip.top}px`}}>{tip.text}</div>}
    {infoOpen && <div id={overlayId} className="tg-info-overlay" role="tooltip" style={infoPosition ? {left:`${infoPosition.left}px`,top:`${infoPosition.top}px`} : undefined}>{`Task Gantt PCF version ${CONTROL_VERSION}`}</div>}
  </section>;
};

