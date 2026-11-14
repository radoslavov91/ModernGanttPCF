import { normalizeId } from "./fieldMap";
import { Hierarchy, HierarchyNode } from "./hierarchy";

// Read-only dependency lines. One engine serves Project Operations (verified defaults) and opt-in custom link tables.
export type LinkType = "FS" | "SS" | "FF" | "SF";
export type DependencyLink = {
  id:string;
  predecessorId:string;
  successorId:string;
  type:LinkType;
  // Display names are only set when Dataverse returned them with the link row.
  predecessorName?:string;
  successorName?:string;
};
export type SkipReason = "unknownType" | "conflictingType" | "missingEndpoint";
export type SkippedLink = { id:string; reason:SkipReason; value?:string };
export type LinkSource = {
  kind:"projectOperations" | "custom";
  table:string;
  idColumn:string;
  predecessorColumn:string;
  successorColumn:string;
  // Authoritative link-type column; without one every link is Finish-to-Start.
  linkTypeColumn?:string;
  // Mirror column used only as a consistency check.
  mirrorLinkTypeColumn?:string;
  scopeColumn?:string;
};

export const LINK_TYPE_LABELS:Record<LinkType,string> = { FS: "Finish-to-Start", SS: "Start-to-Start", FF: "Finish-to-Finish", SF: "Start-to-Finish" };

// Verified on msdyn_projecttaskdependency (org3b1c1cb9, 2026-11-14). msdyn_linktype is the original, application-required
// "Link Type" column; msdyn_projecttaskdependencylinktype mirrors it with its own numbering.
const PO_LINK_TYPES:Record<string,LinkType> = { "192350000": "FS", "192350001": "SS", "192350002": "FF", "192350004": "SF" };
const PO_MIRROR_LINK_TYPES:Record<string,LinkType> = { "0": "FF", "1": "FS", "2": "SF", "3": "SS" };

export const PROJECT_OPERATIONS_LINKS:LinkSource = {
  kind: "projectOperations",
  table: "msdyn_projecttaskdependency",
  idColumn: "msdyn_projecttaskdependencyid",
  predecessorColumn: "msdyn_predecessortask",
  successorColumn: "msdyn_successortask",
  linkTypeColumn: "msdyn_linktype",
  mirrorLinkTypeColumn: "msdyn_projecttaskdependencylinktype",
  scopeColumn: "msdyn_project"
};

const LOGICAL_NAME = /^[a-z][a-z0-9_]*$/;

export type CustomLinkSettings = { table?:string|null; predecessorColumn?:string|null; successorColumn?:string|null };

// Custom link tables support Finish-to-Start only. Returns an error message instead of a source when misconfigured.
export function customLinkSource(settings:CustomLinkSettings):{ source?:LinkSource; error?:string } {
  const clean = (value?:string|null) => (value ?? "").trim().toLowerCase();
  const table = clean(settings.table), predecessor = clean(settings.predecessorColumn), successor = clean(settings.successorColumn);
  if (!table && !predecessor && !successor) return {};
  const missing = [!table && "Dependency table", !predecessor && "Predecessor column", !successor && "Successor column"].filter(Boolean);
  if (missing.length) return { error: `Dependency lines need ${missing.join(", ")}.` };
  const invalid = [table, predecessor, successor].filter(name => !LOGICAL_NAME.test(name));
  if (invalid.length) return { error: `Dependency settings must be logical names: ${invalid.join(", ")}.` };
  return { source: { kind: "custom", table, idColumn: `${table}id`, predecessorColumn: predecessor, successorColumn: successor } };
}

const lookupKey = (column:string) => `_${column}_value`;
const FORMATTED = "@OData.Community.Display.V1.FormattedValue";

export function buildLinkFetchXml(source:LinkSource, taskIds:string[], scopeId?:string):string {
  const attributes = [source.idColumn, source.predecessorColumn, source.successorColumn, source.linkTypeColumn, source.mirrorLinkTypeColumn]
    .filter(Boolean).map(name => `<attribute name="${name}" />`).join("");
  const values = taskIds.map(id => `<value>${normalizeId(id)}</value>`).join("");
  const scope = source.scopeColumn && scopeId ? `<condition attribute="${source.scopeColumn}" operator="eq" value="${normalizeId(scopeId)}" />` : "";
  return `<fetch><entity name="${source.table}">${attributes}<filter type="and"><condition attribute="statecode" operator="eq" value="0" />${scope}` +
    `<filter type="or"><condition attribute="${source.predecessorColumn}" operator="in">${values}</condition>` +
    `<condition attribute="${source.successorColumn}" operator="in">${values}</condition></filter></filter></entity></fetch>`;
}

function readType(source:LinkSource, row:Record<string,unknown>):{ type?:LinkType; skip?:{ reason:SkipReason; value?:string } } {
  if (!source.linkTypeColumn) return { type: "FS" };
  const raw = row[source.linkTypeColumn];
  const value = raw === null || raw === undefined ? "" : String(raw);
  const type = source.kind === "projectOperations" ? PO_LINK_TYPES[value] : undefined;
  if (!type) return { skip: { reason: "unknownType", value: value || "(empty)" } };
  if (source.mirrorLinkTypeColumn) {
    const mirrorRaw = row[source.mirrorLinkTypeColumn];
    if (mirrorRaw !== null && mirrorRaw !== undefined && mirrorRaw !== "") {
      const mirror = PO_MIRROR_LINK_TYPES[String(mirrorRaw)];
      if (mirror && mirror !== type) return { skip: { reason: "conflictingType", value: `${value}/${String(mirrorRaw)}` } };
    }
  }
  return { type };
}

export function parseLinkRow(source:LinkSource, row:Record<string,unknown>):{ link?:DependencyLink; skipped?:SkippedLink } {
  const id = String(row[source.idColumn] ?? "");
  const predecessor = row[lookupKey(source.predecessorColumn)];
  const successor = row[lookupKey(source.successorColumn)];
  if (typeof predecessor !== "string" || typeof successor !== "string" || !predecessor || !successor) {
    return { skipped: { id, reason: "missingEndpoint" } };
  }
  const { type, skip } = readType(source, row);
  if (!type) return { skipped: { id, ...(skip as { reason:SkipReason; value?:string }) } };
  const name = (key:string) => {
    const text = row[`${key}${FORMATTED}`];
    return typeof text === "string" && text.trim() ? text.trim() : undefined;
  };
  const predecessorName = name(lookupKey(source.predecessorColumn));
  const successorName = name(lookupKey(source.successorColumn));
  return { link: {
    id: normalizeId(id || `${predecessor}:${successor}:${type}`),
    predecessorId: normalizeId(predecessor),
    successorId: normalizeId(successor),
    type,
    ...(predecessorName ? { predecessorName } : {}),
    ...(successorName ? { successorName } : {})
  } };
}

export function describeSkipped(skipped:SkippedLink[]):string {
  const groups = new Map<string,number>();
  skipped.forEach(item => {
    const label = item.reason === "unknownType" ? `unknown link type ${item.value}` : item.reason === "conflictingType" ? `conflicting link types ${item.value}` : "missing predecessor or successor";
    groups.set(label, (groups.get(label) ?? 0) + 1);
  });
  return Array.from(groups.entries()).map(([label, count]) => `${count} with ${label}`).join("; ");
}

// --- Layout -------------------------------------------------------------------------------------------------------

export type RowAnchor = {
  recordId:string;
  rowIndex:number;
  // Timeline x positions of the bar's start and end (diamond centre for milestones); null when nothing is drawn.
  start:number|null;
  end:number|null;
};
export type DependencyLine = {
  key:string;
  fromRow:number;
  toRow:number;
  x1:number;
  x2:number;
  fromSide:"start" | "end";
  toSide:"start" | "end";
  type:LinkType;
  // Drawn to a collapsed parent instead of the hidden task.
  viaCollapsed:boolean;
  count:number;
  title:string;
};
export type DependencyStub = { key:string; rowIndex:number; x:number; side:"start" | "end"; title:string };
export type DependencyLayout = {
  lines:DependencyLine[];
  stubs:DependencyStub[];
  notLoaded:number;
  unscheduled:number;
  hiddenInCollapsed:number;
};

// Maps every loaded record to the row that represents it: itself when visible, or its nearest visible (collapsed)
// ancestor. Rows that are not loaded have no entry.
export function representatives(hierarchy:Hierarchy|undefined, flatIds:string[], collapsed:ReadonlySet<string>):Map<string,{ rowId:string; hidden:boolean }> {
  const map = new Map<string,{ rowId:string; hidden:boolean }>();
  if (!hierarchy) {
    flatIds.forEach(id => map.set(normalizeId(id), { rowId: id, hidden: false }));
    return map;
  }
  const walk = (node:HierarchyNode, visibleAncestor:string|undefined) => {
    const id = node.task.recordId;
    map.set(normalizeId(id), visibleAncestor ? { rowId: visibleAncestor, hidden: true } : { rowId: id, hidden: false });
    const childAncestor = visibleAncestor ?? (collapsed.has(id) ? id : undefined);
    node.children.forEach(child => walk(child, childAncestor));
  };
  hierarchy.roots.forEach(root => walk(root, undefined));
  return map;
}

const fromSideOf = (type:LinkType):"start" | "end" => type === "SS" || type === "SF" ? "start" : "end";
const toSideOf = (type:LinkType):"start" | "end" => type === "FS" || type === "SS" ? "start" : "end";

export function layoutDependencies(links:DependencyLink[], rows:RowAnchor[], reps:Map<string,{ rowId:string; hidden:boolean }>, names:Map<string,string>):DependencyLayout {
  const byRecord = new Map(rows.map(row => [row.recordId, row]));
  const result:DependencyLayout = { lines: [], stubs: [], notLoaded: 0, unscheduled: 0, hiddenInCollapsed: 0 };
  const merged = new Map<string,DependencyLine>();
  const label = (id:string, fallback?:string) => names.get(normalizeId(id)) ?? fallback;

  links.forEach(link => {
    const from = reps.get(link.predecessorId), to = reps.get(link.successorId);
    const fromSide = fromSideOf(link.type), toSide = toSideOf(link.type);
    const typeLabel = LINK_TYPE_LABELS[link.type];
    if (!from && !to) return;
    if (!from || !to) {
      // One end is not among the loaded rows: filtered out, on a later page or not readable.
      result.notLoaded += 1;
      const present = (from ?? to) as { rowId:string };
      const row = byRecord.get(present.rowId);
      const side = from ? fromSide : toSide;
      const x = row ? row[side] : null;
      if (!row || x === null) return;
      const missingName = from ? link.successorName : link.predecessorName;
      const role = from ? "Successor" : "Predecessor";
      result.stubs.push({ key: `${link.id}:stub`, rowIndex: row.rowIndex, x, side,
        title: `${role} ${missingName ? `${missingName} ` : ""}is not in the loaded rows (${typeLabel})` });
      return;
    }
    if (from.rowId === to.rowId) {
      if (from.hidden || to.hidden) result.hiddenInCollapsed += 1;
      return;
    }
    const fromRow = byRecord.get(from.rowId), toRow = byRecord.get(to.rowId);
    if (!fromRow || !toRow) return;
    const x1 = fromRow[fromSide], x2 = toRow[toSide];
    if (x1 === null || x2 === null) { result.unscheduled += 1; return; }
    const viaCollapsed = from.hidden || to.hidden;
    const key = `${from.rowId}>${to.rowId}:${link.type}:${viaCollapsed ? "c" : "d"}`;
    const existing = merged.get(key);
    if (existing) {
      existing.count += 1;
      existing.title = `${existing.count} links: ${label(from.rowId, "")} → ${label(to.rowId, "")}, ${typeLabel}`;
      return;
    }
    const fromName = label(link.predecessorId, link.predecessorName) ?? "Predecessor";
    const toName = label(link.successorId, link.successorName) ?? "Successor";
    merged.set(key, { key, fromRow: fromRow.rowIndex, toRow: toRow.rowIndex, x1, x2, fromSide, toSide, type: link.type, viaCollapsed, count: 1,
      title: `${fromName} → ${toName}, ${typeLabel}${viaCollapsed ? " (inside a collapsed group)" : ""}` });
  });
  result.lines = Array.from(merged.values());
  return result;
}

// Orthogonal route from (x1,y1) to (x2,y2). Leaves the predecessor away from its bar and enters the successor from
// outside its bar. When the ends are too close (same day or overlap) the route loops between the two rows.
export function routePath(x1:number, y1:number, x2:number, y2:number, fromSide:"start" | "end", toSide:"start" | "end", gap = 8):string {
  const out = fromSide === "end" ? 1 : -1;
  const into = toSide === "start" ? 1 : -1;
  const p1 = x1 + out * gap;
  const p2 = x2 - into * gap;
  let vertical:number|null = null;
  if (out === 1 && into === 1) vertical = p1 <= p2 ? p1 : null;
  else if (out === -1 && into === -1) vertical = p2 <= p1 ? p1 : null;
  else if (out === -1 && into === 1) vertical = Math.min(p1, p2);
  else vertical = Math.max(p1, p2);
  const r = (n:number) => Math.round(n * 10) / 10;
  if (vertical !== null) return `M${r(x1)} ${r(y1)} H${r(vertical)} V${r(y2)} H${r(x2)}`;
  const middle = (y1 + y2) / 2;
  return `M${r(x1)} ${r(y1)} H${r(p1)} V${r(middle)} H${r(p2)} V${r(y2)} H${r(x2)}`;
}

export function stubPath(x:number, y:number, side:"start" | "end", length = 12):string {
  const dx = side === "end" ? length : -length;
  return `M${x} ${y} h${dx}`;
}
