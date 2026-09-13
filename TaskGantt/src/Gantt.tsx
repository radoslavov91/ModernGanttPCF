import * as React from "react";

export type StatusFilter = "all" | "active" | "completed" | "overdue";
export type DateFilter = "all" | "thisWeek" | "lastWeek" | "thisMonth" | "lastMonth";
export type SortKey = "task" | "assignedTo" | "status" | "startDate" | "dueDate";
export type SortDirection = "asc" | "desc";
export type SortState = { key:SortKey; direction:SortDirection } | undefined;
export type TaskItem = { recordId:string; name:string; assignedTo:string; status:"Active"|"Completed"; start:Date; due:Date };
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
export const CONTROL_VERSION = "3.2";

export type TaskFilters = {
  status: StatusFilter;
  createdOn: DateFilter;
  dueDate: DateFilter;
};

type Props = {
  tasks:TaskItem[];
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
  onOpen:(id:string)=>void;
  onLoadMore?:()=>void;
};

export type TaskUrgency = "completed" | "overdue" | "dueSoon" | "normal";
const DAY = 86400000;
const clamp = (value:number,min:number,max:number) => Math.min(max,Math.max(min,value));
const startOfDay = (d:Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d:Date,n:number) => new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);
const fmt = (d:Date) => d.toLocaleDateString(undefined,{day:"2-digit",month:"short",year:"numeric"});
export const getTaskUrgency = (task:TaskItem, now:Date = new Date()):TaskUrgency => {
  if (task.status === "Completed") return "completed";
  if (isNaN(task.due.getTime())) return "normal";
  const dueDay = startOfDay(task.due).getTime();
  const today = startOfDay(now);
  const todayTime = today.getTime();
  if (dueDay < todayTime) return "overdue";
  if (dueDay <= addDays(today,2).getTime()) return "dueSoon";
  return "normal";
};

const urgencyText = (urgency:TaskUrgency,due:Date) => urgency === "overdue" ? `Overdue \u2014 due ${fmt(due)}` : urgency === "dueSoon" ? `Due soon \u2014 due ${fmt(due)}` : "";

const UrgencyIndicator: React.FC<{urgency:TaskUrgency;due:Date}> = ({urgency,due}) => {
  if (urgency !== "overdue" && urgency !== "dueSoon") return null;
  const label = urgencyText(urgency,due);
  return <span className={`tg-urgency ${urgency}`} role="img" aria-label={label} title={label}>
    {urgency === "overdue"
      ? <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="7"/><path d="M8 3.8v5.4M8 11.8h.01"/></svg>
      : <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.8 15 14H1L8 1.8Z"/><path d="M8 5.6v4.2M8 12.1h.01"/></svg>}
  </span>;
};

export const Gantt: React.FC<Props> = ({tasks,allocatedHeight,allocatedWidth,loading,filters,sorting,licenseState,licenseMessage,onRevalidateLicense,onFiltersChange,onSortChange,onOpen,onLoadMore}) => {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const todayRef = React.useRef<HTMLElement>(null);
  const positionedSignatures = React.useRef<Record<string,string>>({});
  const lastTimelineSignature = React.useRef("");

  const changeFilters = (nextFilters:TaskFilters) => {
    scrollRef.current?.scrollTo({top:0,left:0,behavior:"auto"});
    onFiltersChange(nextFilters);
  };
  const changeSort = (key:SortKey) => {
    const direction:SortDirection = sorting?.key === key && sorting.direction === "asc" ? "desc" : "asc";
    scrollRef.current?.scrollTo({top:scrollRef.current.scrollTop,left:0,behavior:"auto"});
    onSortChange({key,direction});
  };

  const validTasks = tasks.filter(t => !isNaN(t.start.getTime()) && !isNaN(t.due.getTime()));
  const rangeTasks = validTasks.length ? validTasks : [{start:new Date(),due:new Date()} as TaskItem];
  const today = startOfDay(new Date());
  const min = startOfDay(new Date(Math.min(today.getTime(),...rangeTasks.map(t=>t.start.getTime()))));
  const max = startOfDay(new Date(Math.max(today.getTime(),...rangeTasks.map(t=>Math.max(t.start.getTime(),t.due.getTime())))));
  const timelineStart = addDays(min,-1), timelineEnd = addDays(max,1);
  const numberOfDays = Math.max(1,Math.round((timelineEnd.getTime()-timelineStart.getTime())/DAY)+1);
  const dateCells = Array.from({length:numberOfDays},(_,i)=>addDays(timelineStart,i));
  const todayIndex = Math.round((today.getTime()-timelineStart.getTime())/DAY);
  const allocatedWidthNumber = Number(allocatedWidth) || 0;
  const compactMode = allocatedWidthNumber > 0 && allocatedWidthNumber < 1050;
  const compactFallback = compactMode && allocatedWidthNumber < 760;
  const taskNameWidth = compactMode ? (compactFallback ? 190 : 230) : 240;
  const assignedToWidth = compactMode ? 0 : 170;
  const statusWidth = compactMode ? (compactFallback ? 82 : 90) : 105;
  const startDateWidth = compactMode ? 0 : 115;
  const dueDateWidth = compactMode ? (compactFallback ? 130 : 145) : 115;
  const dayWidth = compactMode ? (compactFallback ? 32 : allocatedWidthNumber < 900 ? 34 : 36) : allocatedWidthNumber < 700 ? 28 : allocatedWidthNumber < 1100 ? 32 : 38;
  const timelineWidth = numberOfDays * dayWidth;
  const grid = compactMode
    ? `var(--tg-task-name-width) var(--tg-status-width) var(--tg-due-date-width) ${timelineWidth}px`
    : `var(--tg-task-name-width) var(--tg-assigned-to-width) var(--tg-status-width) var(--tg-start-date-width) var(--tg-due-date-width) ${timelineWidth}px`;
  const timelineGrid = `repeat(${numberOfDays}, ${dayWidth}px)`;
  const rootStyle = {
    "--tg-allocated-height": allocatedHeight > 0 ? `${allocatedHeight}px` : "100%",
    "--tg-task-name-width": `${taskNameWidth}px`,
    "--tg-assigned-to-width": `${assignedToWidth}px`,
    "--tg-status-width": `${statusWidth}px`,
    "--tg-start-date-width": `${startDateWidth}px`,
    "--tg-due-date-width": `${dueDateWidth}px`,
    "--tg-assigned-to-left": `${taskNameWidth}px`,
    "--tg-status-left": `${taskNameWidth + assignedToWidth}px`,
    "--tg-start-date-left": `${taskNameWidth + assignedToWidth + statusWidth}px`,
    "--tg-due-date-left": `${compactMode ? taskNameWidth + statusWidth : taskNameWidth + assignedToWidth + statusWidth + startDateWidth}px`
  } as React.CSSProperties;
  const hasActiveFilters = filters.status !== "all" || filters.createdOn !== "all" || filters.dueDate !== "all";
  const now = new Date();
  const sortSignature = sorting ? `${sorting.key}:${sorting.direction}` : "default";
  const filterSignature = `${filters.status}|${filters.createdOn}|${filters.dueDate}|${sortSignature}`;
  const layoutMode = compactMode ? "compact" : "detailed";
  const timelineSignature = `${layoutMode}|${timelineStart.getTime()}|${numberOfDays}|${dayWidth}`;

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

  const renderTimelineCells = () => dateCells.map((d,i)=><i key={i} className={d.getDay()%6===0?"weekend":""}/>);
  const renderSortHeader = (label:string,key:SortKey,className:string) => {
    const active = sorting?.key === key;
    const ariaSort = active ? sorting.direction === "asc" ? "ascending" : "descending" : "none";
    return <div className={`tg-hcell tg-sticky ${className}`} role="columnheader" aria-sort={ariaSort}>
      <button className="tg-sort" type="button" onClick={()=>changeSort(key)}>
        <span>{label}</span>{active && <i aria-hidden="true">{sorting.direction === "asc" ? "\u2303" : "\u2304"}</i>}
      </button>
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

  return <section className={`tg ${compactMode ? "tg-compact" : "tg-detailed"}`} style={rootStyle} aria-label="Tasks Gantt">
    <header className="tg-toolbar">
      <span className="tg-title"><strong>Tasks Plan</strong><button className="tg-info" type="button" aria-label={`Task Gantt PCF version ${CONTROL_VERSION}`}><span aria-hidden="true">i</span><em>Task Gantt PCF version {CONTROL_VERSION}</em></button></span>
      <span className="tg-filters">
        <label className="tg-filter">Created On
          <select value={filters.createdOn} onChange={event=>changeFilters({...filters,createdOn:event.target.value as DateFilter})}>
            <option value="all">All dates</option>
            <option value="thisWeek">This week</option>
            <option value="lastWeek">Last week</option>
            <option value="thisMonth">This month</option>
            <option value="lastMonth">Last month</option>
          </select>
        </label>
        <label className="tg-filter">Due Date
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
        {validTasks.length>10 && <button title="Return to the first tasks" aria-label="Return to the first tasks" onClick={()=>scrollRef.current?.scrollTo({top:0,behavior:"smooth"})}>{"\u2191"}</button>}
        <span className="tg-legend" role="group" aria-label="Status filter">
          <button type="button" aria-pressed={filters.status==="all"} className={filters.status==="all" ? "selected" : ""} onClick={()=>changeFilters({...filters,status:"all"})}>All</button>
          <button type="button" aria-pressed={filters.status==="active"} className={filters.status==="active" ? "selected" : ""} onClick={()=>changeFilters({...filters,status:"active"})}><i className="active"/>Active</button>
          <button type="button" aria-pressed={filters.status==="completed"} className={filters.status==="completed" ? "selected" : ""} onClick={()=>changeFilters({...filters,status:"completed"})}><i className="completed"/>Completed</button>
          <button type="button" aria-pressed={filters.status==="overdue"} className={filters.status==="overdue" ? "selected" : ""} onClick={()=>changeFilters({...filters,status:"overdue"})}><i className="overdue"/>Overdue</button>
        </span>
      </span>
    </header>
    <div ref={scrollRef} className="tg-scroll">
      <div className="tg-head" style={{gridTemplateColumns:grid}}>
        {renderSortHeader(compactMode ? "Task" : "Task name","task","tg-col-task")}
        {!compactMode && renderSortHeader("Assigned to","assignedTo","tg-col-assigned")}
        {renderSortHeader("Status","status","tg-col-status")}
        {!compactMode && renderSortHeader("Start Date","startDate","tg-col-start")}
        {renderSortHeader(compactMode ? "Schedule" : "Due Date",compactMode ? "startDate" : "dueDate","tg-col-due")}
        <div className="tg-calendar" style={{gridTemplateColumns:timelineGrid}}>
          {dateCells.map((d,i)=><div key={i} className={d.getDay()%6===0?"weekend":""}><b>{d.getDate()}</b><small>{d.toLocaleDateString(undefined,{weekday:"narrow"})}</small></div>)}
          {todayIndex>=0&&todayIndex<numberOfDays&&<em ref={todayRef} className="tg-today" data-tg-today="true" style={{left:`${todayIndex*dayWidth+(dayWidth/2)}px`}}/>}
        </div>
      </div>
      {!validTasks.length && <div className="tg-empty">{loading ? "Loading tasks..." : hasActiveFilters ? "No tasks match the selected filters" : "No tasks found."}</div>}
      {validTasks.map(t=>{
        const invalidDates = t.due < t.start;
        const urgency = getTaskUrgency(t, now);
        const startDayIndex = Math.max(0,Math.round((startOfDay(t.start).getTime()-timelineStart.getTime())/DAY));
        const inclusiveDurationDays = invalidDates ? 0 : Math.max(1,Math.round((startOfDay(t.due).getTime()-startOfDay(t.start).getTime())/DAY)+1);
        const barLeft = startDayIndex * dayWidth;
        const barWidth = inclusiveDurationDays * dayWidth;
        const barTitle = urgency === "overdue" || urgency === "dueSoon" ? urgencyText(urgency,t.due) : `${t.name}: ${fmt(t.start)} - ${fmt(t.due)}`;
        const barAriaLabel = urgency === "overdue" || urgency === "dueSoon" ? `${t.name}: ${urgencyText(urgency,t.due)}` : `${t.name}: ${fmt(t.start)} - ${fmt(t.due)}`;
        const barClass = urgency === "overdue" ? "overdue" : urgency === "dueSoon" ? "due-soon" : t.status.toLowerCase();
        return <div className="tg-row" style={{gridTemplateColumns:grid}} key={t.recordId}>
          <div className="tg-task-cell tg-sticky tg-col-task">
            <span className="tg-task-title"><button className="tg-link" onClick={()=>onOpen(t.recordId)} title={t.name} aria-label={`${t.name}, owner ${t.assignedTo}`}>{t.name}</button><UrgencyIndicator urgency={urgency} due={t.due}/></span>
            {compactMode && <span className="tg-owner">{t.assignedTo}</span>}
          </div>
          {!compactMode && <div className="tg-sticky tg-col-assigned">{t.assignedTo}</div>}
          <div className="tg-sticky tg-col-status"><span className={`tg-status ${t.status.toLowerCase()}`}>{t.status}</span></div>
          {!compactMode && <div className="tg-sticky tg-col-start">{fmt(t.start)}</div>}
          <div className="tg-schedule tg-sticky tg-col-due" aria-label={`${t.name} schedule from ${fmt(t.start)} to ${fmt(t.due)}${invalidDates ? ". Invalid dates: Due Date is earlier than Start Date." : ""}`}>
            {compactMode
              ? <><span>{fmt(t.start)}</span><span aria-hidden="true">{"\u2192"}</span><span>{fmt(t.due)}</span>{invalidDates && <small>Invalid dates</small>}</>
              : fmt(t.due)}
          </div>
          <div className="tg-track" style={{gridTemplateColumns:timelineGrid}}>
            {renderTimelineCells()}
            {invalidDates
              ? <span className="tg-warning" title="Due Date is earlier than Start Date">Invalid dates</span>
              : <span className={`tg-bar ${barClass}`} style={{left:`${barLeft}px`,width:`${barWidth}px`}} title={barTitle} aria-label={barAriaLabel}>{t.status==="Completed" ? "\u2713" : ""}</span>}
            {todayIndex>=0&&todayIndex<numberOfDays&&<em className="tg-today" style={{left:`${todayIndex*dayWidth+(dayWidth/2)}px`}}/>}
          </div>
        </div>})}
      {onLoadMore && <button className="tg-more" title="Load the next 10 tasks" aria-label="Load the next 10 tasks" disabled={loading} onClick={onLoadMore}>{loading ? "..." : "\u2193"}</button>}
    </div>
  </section>;
};
