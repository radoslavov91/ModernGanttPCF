import { hasDate, normalizeId, TaskItem } from "./fieldMap";

// A summary bar span. derived=true means it was computed from the loaded child rows only, so it may be incomplete.
export type SummarySpan = { start:Date; end:Date; derived:boolean; loadedChildCount:number };
export type HierarchyNode = {
  task:TaskItem;
  children:HierarchyNode[];
  // The row has a parent reference, but no loaded row matches it (filtered out, on a later page or not readable).
  parentMissing:boolean;
  // The row's parent link was cut because it formed a loop (or pointed at the row itself).
  cycleBroken:boolean;
};
export type Hierarchy = {
  roots:HierarchyNode[];
  waitingCount:number;
  brokenCycleIds:string[];
  // Set when the parent lookup points at another table; the rows are then shown flat.
  mismatchedTarget?:string;
};
export type VisibleRow = {
  task:TaskItem;
  depth:number;
  hasChildren:boolean;
  expanded:boolean;
  parentMissing:boolean;
  isSummaryRow:boolean;
  summary:SummarySpan|null;
};

const flatNode = (task:TaskItem):HierarchyNode => ({ task, children:[], parentMissing:false, cycleBroken:false });

// Stable sort by sequence; rows without a sequence keep their incoming order after the numbered ones.
function orderBySequence(nodes:HierarchyNode[]):HierarchyNode[] {
  return nodes
    .map((node,index)=>({node,index}))
    .sort((a,b)=>{
      const as = a.node.task.sequence, bs = b.node.task.sequence;
      const aNull = as === null || as === undefined, bNull = bs === null || bs === undefined;
      if (aNull && bNull) return a.index - b.index;
      if (aNull) return 1;
      if (bNull) return -1;
      return (as as number) - (bs as number) || a.index - b.index;
    })
    .map(item=>item.node);
}

// Builds the tree from every loaded row. Siblings keep the incoming (display) order unless useSequence is set.
export function buildHierarchy(tasks:TaskItem[], options:{ entityType?:string|null; useSequence:boolean }):Hierarchy {
  const entityType = (options.entityType ?? "").trim().toLowerCase();
  const mismatch = entityType ? tasks.find(task => task.parent?.entityType && task.parent.entityType !== entityType) : undefined;
  if (mismatch) {
    return { roots: tasks.map(flatNode), waitingCount: 0, brokenCycleIds: [], mismatchedTarget: mismatch.parent?.entityType };
  }

  const keyOf = (task:TaskItem) => normalizeId(task.recordId);
  const nodes = new Map<string,HierarchyNode>();
  tasks.forEach(task => nodes.set(keyOf(task), flatNode(task)));

  const parentOf = new Map<string,string>();
  tasks.forEach(task => {
    const key = keyOf(task);
    const parentKey = task.parent?.id;
    if (!parentKey) return;
    if (parentKey === key) { (nodes.get(key) as HierarchyNode).cycleBroken = true; return; }
    if (nodes.has(parentKey)) parentOf.set(key, parentKey);
    else (nodes.get(key) as HierarchyNode).parentMissing = true;
  });

  // Rows are visited in display order, so the first row of any loop is the one whose link is cut.
  tasks.forEach(task => {
    const key = keyOf(task);
    const seen = new Set([key]);
    let current = parentOf.get(key);
    while (current !== undefined) {
      if (current === key) {
        parentOf.delete(key);
        (nodes.get(key) as HierarchyNode).cycleBroken = true;
        break;
      }
      if (seen.has(current)) break;
      seen.add(current);
      current = parentOf.get(current);
    }
  });

  const roots:HierarchyNode[] = [];
  tasks.forEach(task => {
    const key = keyOf(task);
    const node = nodes.get(key) as HierarchyNode;
    const parentKey = parentOf.get(key);
    if (parentKey) (nodes.get(parentKey) as HierarchyNode).children.push(node);
    else roots.push(node);
  });

  const order = (list:HierarchyNode[]):HierarchyNode[] => {
    const ordered = options.useSequence ? orderBySequence(list) : list;
    ordered.forEach(node => { node.children = order(node.children); });
    return ordered;
  };

  const all = Array.from(nodes.values());
  return {
    roots: order(roots),
    waitingCount: all.filter(node => node.parentMissing).length,
    brokenCycleIds: all.filter(node => node.cycleBroken).map(node => node.task.recordId)
  };
}

const descendants = (node:HierarchyNode):HierarchyNode[] => node.children.flatMap(child => [child, ...descendants(child)]);

export function isSummaryNode(node:HierarchyNode):boolean {
  return node.children.length > 0 || node.task.isSummary === true;
}

// Stored dates win (Project Operations keeps rolled-up dates on summary tasks). Without both stored dates the span
// comes from the loaded descendants and is marked derived, because unloaded children may lie outside it.
export function summarySpan(node:HierarchyNode):SummarySpan|null {
  if (!isSummaryNode(node)) return null;
  const { start, due } = node.task;
  const loadedChildCount = node.children.length;
  if (hasDate(start) && hasDate(due) && due >= start) return { start, end: due, derived: false, loadedChildCount };

  const points = descendants(node).flatMap(child => [child.task.start, child.task.due]).filter(hasDate);
  if (!points.length) return null;
  const times = points.map(point => point.getTime());
  return { start: new Date(Math.min(...times)), end: new Date(Math.max(...times)), derived: true, loadedChildCount };
}

// Depth-first rows in display order. Children of collapsed rows are skipped; pass an empty set for every row.
export function visibleRows(hierarchy:Hierarchy, collapsed:ReadonlySet<string>):VisibleRow[] {
  const rows:VisibleRow[] = [];
  const walk = (node:HierarchyNode, depth:number) => {
    const expanded = !collapsed.has(node.task.recordId);
    rows.push({
      task: node.task,
      depth,
      hasChildren: node.children.length > 0,
      expanded,
      parentMissing: node.parentMissing,
      isSummaryRow: isSummaryNode(node),
      summary: summarySpan(node)
    });
    if (expanded) node.children.forEach(child => walk(child, depth + 1));
  };
  hierarchy.roots.forEach(root => walk(root, 0));
  return rows;
}
