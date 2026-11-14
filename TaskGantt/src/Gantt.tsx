import * as React from "react";
import { GanttLayout, hasDate, normalizeId, TASK_LAYOUT, TaskItem } from "./fieldMap";
import { Hierarchy, SummarySpan, VisibleRow, visibleRows } from "./hierarchy";
import { describeSkipped, layoutDependencies, representatives, routePath, RowAnchor, stubPath } from "./dependencies";
import type { DependencyView } from "./dependencyLoader";

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
export const CONTROL_VERSION = "3.5.0";

export type TaskFilters = {
  status: StatusFilter;
  createdOn: DateFilter;
  dueDate: DateFilter;
};

type Props = {
  tasks:TaskItem[];
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

export type TaskUrgency = "completed" | "overdue" | "dueSoon" | "normal";
const DAY = 86400000;
const clamp = (value:number,min:number,max:number) => Math.min(max,Math.max(min,value));
const startOfDay = (d:Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d:Date,n:number) => new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);
const fmt = (d:Date) => d.toLocaleDateString(undefined,{day:"2-digit",month:"short",year:"numeric"});
const bodyOverlayIds = new Set<string>();

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

export function cleanupTaskGanttOverlays(instanceId?:string):void {
  if (typeof document === "undefined") return;
  const ids = instanceId ? [`tg-info-overlay-${instanceId}`] : Array.from(bodyOverlayIds);
  ids.forEach(id=>{
    document.getElementById(id)?.remove();
    bodyOverlayIds.delete(id);
  });
}

export const getTaskUrgency = (task:TaskItem, now:Date = new Date()):TaskUrgency => {
  if (task.status === "Completed") return "completed";
  if (!hasDate(task.due)) return "normal";
  const dueDay = startOfDay(task.due).getTime();
  const today = startOfDay(now);
  const todayTime = today.getTime();
  if (dueDay < todayTime) return "overdue";
  if (dueDay <= addDays(today,2).getTime()) return "dueSoon";
  return "normal";
};

const urgencyText = (urgency:TaskUrgency,due:Date) => urgency === "overdue" ? `Overdue \u2014 due ${fmt(due)}` : urgency === "dueSoon" ? `Due soon \u2014 due ${fmt(due)}` : "";

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

const UrgencyIndicator: React.FC<{urgency:TaskUrgency;due:Date|null}> = ({urgency,due}) => {
  if ((urgency !== "overdue" && urgency !== "dueSoon") || !hasDate(due)) return null;
  const label = urgencyText(urgency,due);
  return <span className={`tg-urgency ${urgency}`} role="img" aria-label={label} title={label}>
    {urgency === "overdue"
      ? <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="7"/><path d="M8 3.8v5.4M8 11.8h.01"/></svg>
      : <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.8 15 14H1L8 1.8Z"/><path d="M8 5.6v4.2M8 12.1h.01"/></svg>}
  </span>;
};

export const Gantt: React.FC<Props> = ({tasks,hierarchy,dependencies,pageSize = 10,layout = TASK_LAYOUT,allocatedHeight,allocatedWidth,loading,filters,sorting,licenseState,licenseMessage,onRevalidateLicense,onFiltersChange,onSortChange,onRefresh,onOpen,onLoadMore,refreshDisabled,refreshing,instanceId}) => {
  const scrollRef = React.useRef<HTMLDivElement>(null);
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
  const today = startOfDay(new Date());
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
  const statusWidth = !layout.showStatus ? 0 : compactMode ? (compactFallback ? 82 : 90) : 105;
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
  const hasActiveFilters = filters.status !== "all" || filters.createdOn !== "all" || filters.dueDate !== "all";
  const now = new Date();
  const sortSignature = sorting ? `${sorting.key}:${sorting.direction}` : "default";
  const filterSignature = `${filters.status}|${filters.createdOn}|${filters.dueDate}|${sortSignature}`;
  const layoutMode = compactMode ? "compact" : "detailed";
  const timelineSignature = `${layoutMode}|${timelineStart.getTime()}|${numberOfDays}|${dayWidth}`;

  React.useEffect(() => {
    if (!infoOpen || typeof document === "undefined") {
      cleanupTaskGanttOverlays(instanceId);
      return undefined;
    }

    const button = infoButtonRef.current;
    if (!button) return undefined;

    const overlay = document.createElement("div");
    overlay.id = overlayId;
    overlay.className = "tg-info-overlay";
    overlay.setAttribute("role", "tooltip");
    overlay.textContent = `Task Gantt PCF version ${CONTROL_VERSION}`;
    document.body.appendChild(overlay);
    bodyOverlayIds.add(overlayId);

    let frame = 0;
    const positionOverlay = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rect = button.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        const gap = 8;
        const viewportPadding = 8;
        const overlayWidth = overlayRect.width || 240;
        const overlayHeight = overlayRect.height || 32;
        const roomBelow = window.innerHeight - rect.bottom;
        const top = roomBelow >= overlayHeight + gap + viewportPadding
          ? rect.bottom + gap
          : Math.max(viewportPadding, rect.top - overlayHeight - gap);
        const preferredLeft = rect.left + (rect.width / 2) - (overlayWidth / 2);
        const left = clamp(preferredLeft, viewportPadding, Math.max(viewportPadding, window.innerWidth - overlayWidth - viewportPadding));
        overlay.style.top = `${top}px`;
        overlay.style.left = `${left}px`;
      });
    };

    const closeIfOutside = (event:PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (button.contains(target) || overlay.contains(target))) return;
      setInfoOpen(false);
    };
    const closeOnEscape = (event:KeyboardEvent) => {
      if (event.key === "Escape") {
        setInfoOpen(false);
        button.focus();
      }
    };

    positionOverlay();
    document.addEventListener("pointerdown", closeIfOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", positionOverlay);
    document.addEventListener("scroll", positionOverlay, true);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeIfOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", positionOverlay);
      document.removeEventListener("scroll", positionOverlay, true);
      cleanupTaskGanttOverlays(instanceId);
    };
  }, [infoOpen, instanceId, overlayId]);

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
      const markerRect = marker.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const currentTop = scroll.scrollTop;
      const stickyCells = Array.from(scroll.querySelectorAll<HTMLElement>(".tg-head .tg-sticky"));
      const measuredFrozenWidth = stickyCells.reduce((total,cell)=>total + cell.getBoundingClientRect().width,0);
      const frozenWidth = Math.min(measuredFrozenWidth, Math.max(0, scroll.clientWidth - dayWidth));
      const visibleTimelineWidth = Math.max(dayWidth, scroll.clientWidth - frozenWidth);
      const markerCenter = markerRect.left - scrollRect.left + scroll.scrollLeft + (markerRect.width / 2);
      const maxLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
      const targetLeft = clamp(markerCenter - frozenWidth - (visibleTimelineWidth / 2), 0, maxLeft);
      scroll.scrollTo({left:targetLeft,top:currentTop,behavior:"auto"});
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
  const renderSortButton = (label:string,key:SortKey) => {
    const active = sorting?.key === key;
    return <button className="tg-sort" type="button" onClick={()=>changeSort(key)}>
      <span>{label}</span>{active && <i aria-hidden="true">{sorting.direction === "asc" ? "\u25B2" : "\u25BC"}</i>}
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
    : dependencies.status === "error" ? {text:"Dependencies unavailable", title:`${dependencies.message ?? "The dependency rows could not be read."} Bars and dates are unaffected.`, error:true}
    : dependencies.status === "loading" ? {text:"Loading dependencies…", title:"Reading dependency rows for the loaded tasks.", error:false}
    : (() => {
      const parts:string[] = [], details:string[] = [];
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
  return <section className={`tg ${compactMode ? "tg-compact" : "tg-detailed"}`} style={rootStyle} aria-label={layout.title === TASK_LAYOUT.title ? "Tasks Gantt" : `${layout.title} Gantt`}>
    <header className="tg-toolbar">
      <span className="tg-title"><strong>{layout.title}</strong><button ref={infoButtonRef} className="tg-info" type="button" aria-label={`Task Gantt PCF version ${CONTROL_VERSION}`} aria-expanded={infoOpen} aria-describedby={infoOpen ? overlayId : undefined} onClick={()=>setInfoOpen(open=>!open)}><span aria-hidden="true">i</span></button><button className={`tg-refresh ${refreshing ? "is-refreshing" : ""}`} type="button" title={`Refresh ${items}`} aria-label={`Refresh ${items}`} disabled={refreshDisabled} onClick={onRefresh}>
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M16.9 3.6v4.7h-4.7l1.8-1.8A5.5 5.5 0 0 0 4.5 10H3.2a6.8 6.8 0 0 1 11.7-4.4l2-2Zm-1.4 6.4h1.3A6.8 6.8 0 0 1 5.1 14.4l-2 2v-4.7h4.7L6 13.5a5.5 5.5 0 0 0 9.5-3.5Z"/></svg>
      </button></span>
      <span className="tg-filters">
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
        {hasActiveFilters && <button className="tg-clear" onClick={()=>changeFilters({status:"all",createdOn:"all",dueDate:"all"})}>Clear filters</button>}
      </span>
      <span className="tg-actions">
        {dependencies && <button type="button" className={`tg-deps-toggle${showDependencies ? " selected" : ""}`} aria-pressed={showDependencies} title={showDependencies ? "Hide dependency lines" : "Show dependency lines"} onClick={()=>setShowDependencies(visible=>!visible)}>Dependencies</button>}
        {dependencyNote && <span className={`tg-deps-status${dependencyNote.error ? " error" : ""}`} role="status" title={dependencyNote.title}>{dependencyNote.text}</span>}
        {hierarchy && hierarchy.waitingCount>0 && <span className="tg-waiting" title={`These ${items} are shown at the top level because their parent is not in the loaded rows: it may be filtered out, on a later page or not accessible.`}>{hierarchy.waitingCount} without loaded parent</span>}
        {tasks.length>10 &&<button title={`Return to the first ${items}`} aria-label={`Return to the first ${items}`} onClick={()=>scrollRef.current?.scrollTo({top:0,behavior:"smooth"})}>{"\u2191"}</button>}
        {layout.showStatusFilter && <span className="tg-legend" role="group" aria-label="Status filter">
          <button type="button" aria-pressed={filters.status==="all"} className={filters.status==="all" ? "selected" : ""} onClick={()=>changeFilters({...filters,status:"all"})}>All</button>
          <button type="button" aria-pressed={filters.status==="active"} className={filters.status==="active" ? "selected" : ""} onClick={()=>changeFilters({...filters,status:"active"})}><i className="active"/>Active</button>
          <button type="button" aria-pressed={filters.status==="completed"} className={filters.status==="completed" ? "selected" : ""} onClick={()=>changeFilters({...filters,status:"completed"})}><i className="completed"/>Completed</button>
          <button type="button" aria-pressed={filters.status==="overdue"} className={filters.status==="overdue" ? "selected" : ""} onClick={()=>changeFilters({...filters,status:"overdue"})}><i className="overdue"/>Overdue</button>
        </span>}
      </span>
      {layout.notice && <span className="tg-notice" role="status">{layout.notice}</span>}
    </header>
    <div ref={scrollRef} className="tg-scroll">
      <div className="tg-head" style={{gridTemplateColumns:grid}}>
        {renderSortHeader(compactMode ? labels.compactTask : labels.task,"task","tg-col-task")}
        {showAssignedColumn && renderSortHeader(labels.owner,"assignedTo","tg-col-assigned")}
        {showDescriptionColumn && <div className="tg-hcell tg-sticky tg-col-description" role="columnheader" aria-sort="none">{labels.description}</div>}
        {layout.showStatus && <div className="tg-hcell tg-sticky tg-col-status" role="columnheader" aria-sort="none">{labels.status}</div>}
        {!compactMode && renderSortHeader(labels.start,"startDate","tg-col-start")}
        {compactMode
          ? <div className="tg-hcell tg-sticky tg-col-due tg-schedule-head" role="columnheader" aria-sort={sorting?.key === "startDate" ? (sorting.direction === "asc" ? "ascending" : "descending") : sorting?.key === "dueDate" ? (sorting.direction === "asc" ? "ascending" : "descending") : "none"}>
              {renderSortButton(labels.compactStart,"startDate")}
              {renderSortButton(labels.compactDue,"dueDate")}
            </div>
          : renderSortHeader(labels.due,"dueDate","tg-col-due")}
        <div className="tg-calendar" style={{gridTemplateColumns:timelineGrid}}>
          {dateCells.map((d,i)=><div key={i} className={d.getDay()%6===0?"weekend":""}><b>{d.getDate()}</b><small>{d.toLocaleDateString(undefined,{weekday:"narrow"})}</small></div>)}
          {todayIndex>=0&&todayIndex<numberOfDays&&<em ref={todayRef} className="tg-today" data-tg-today="true" style={{left:`${todayIndex*dayWidth+(dayWidth/2)}px`}}/>}
        </div>
      </div>
      {!tasks.length && <div className="tg-empty">{loading ? `Loading ${items}...` : hasActiveFilters ? `No ${items} match the selected filters` : `No ${items} found.`}</div>}
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
        const urgency = getTaskUrgency(t, now);
        const urgent = (urgency === "overdue" || urgency === "dueSoon") && hasDate(t.due);
        const range = `${fmtOptional(t.start)} - ${fmtOptional(t.due)}`;
        const startDayIndex = hasDate(t.start) ? Math.max(0,Math.round((startOfDay(t.start).getTime()-timelineStart.getTime())/DAY)) : 0;
        const inclusiveDurationDays = schedule === "scheduled" && hasDate(t.start) && hasDate(t.due) ? Math.max(1,Math.round((startOfDay(t.due).getTime()-startOfDay(t.start).getTime())/DAY)+1) : 0;
        const barLeft = startDayIndex * dayWidth;
        const barWidth = inclusiveDurationDays * dayWidth;
        const barTitle = urgent && hasDate(t.due) ? urgencyText(urgency,t.due) : `${t.name}: ${range}`;
        const barAriaLabel = urgent && hasDate(t.due) ? `${t.name}: ${urgencyText(urgency,t.due)}` : `${t.name}: ${range}`;
        const barClass = urgency === "overdue" ? "overdue" : urgency === "dueSoon" ? "due-soon" : t.status.toLowerCase();
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
              : <span className="tg-toggle-spacer" aria-hidden="true"/>)}<button className="tg-link" onClick={()=>onOpen(t.recordId)} title={t.name} aria-label={layout.showOwner ? `${t.name}, owner ${t.assignedTo}` : t.name}>{t.name}</button><UrgencyIndicator urgency={urgency} due={t.due}/></span>
            {row?.parentMissing && <span className="tg-parent-note" title={parentName ? `Parent ${parentName} is not in the loaded rows` : "The parent is not in the loaded rows"}><span aria-hidden="true">{"↳"} </span>{parentName ?? "Parent not loaded"}</span>}
            {compactMode && layout.showOwner && <span className="tg-owner">{t.assignedTo}</span>}
          </div>
          {showAssignedColumn && <div className="tg-sticky tg-col-assigned">{t.assignedTo}</div>}
          {showDescriptionColumn && <div className="tg-sticky tg-col-description"><span className="tg-description" title={t.description}>{t.description}</span></div>}
          {layout.showStatus && <div className="tg-sticky tg-col-status"><span className={`tg-status ${t.status.toLowerCase()}`}>{t.statusLabel || t.status}</span></div>}
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
              : <span className={`tg-bar ${barClass}`} style={{left:`${barLeft}px`,width:`${barWidth}px`}} title={barTitle} aria-label={barAriaLabel}>{t.status==="Completed" ? "\u2713" : ""}</span>}
            {milestoneDay && <span className={`tg-milestone ${t.status.toLowerCase()}`} style={{left:`${dayIndexOf(milestoneDay)*dayWidth+(dayWidth/2)}px`}} title={milestoneText} aria-label={milestoneText}/>}
            {todayIndex>=0&&todayIndex<numberOfDays&&<em className="tg-today" style={{left:`${todayIndex*dayWidth+(dayWidth/2)}px`}}/>}
          </div>
        </div>}))}
      {onLoadMore && <button className="tg-more" title={`Load the next ${pageSize} ${items}`} aria-label={`Load the next ${pageSize} ${items}`} disabled={loading} onClick={onLoadMore}>{loading ? "..." : "\u2193"}</button>}
    </div>
  </section>;
};
