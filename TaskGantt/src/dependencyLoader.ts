import { normalizeId } from "./fieldMap";
import { buildLinkFetchXml, DependencyLink, describeSkipped, LinkSource, parseLinkRow, SkippedLink } from "./dependencies";

export type WebApiLike = {
  retrieveMultipleRecords(entityType:string, options?:string, maxPageSize?:number):Promise<{ entities:Record<string,unknown>[]; nextLink?:string }>;
};
export type DependencyStatus = "loading" | "ready" | "error";
// Why links could not be read: no project to scope by, no read permission, a configuration error or another failure.
export type DependencyErrorKind = "noProject" | "access" | "config" | "read";
export type DependencyView = {
  status:DependencyStatus;
  links:DependencyLink[];
  skipped:SkippedLink[];
  message?:string;
  errorKind?:DependencyErrorKind;
  // A batch returned more rows than one page; some links may be missing.
  truncated?:boolean;
  // Loaded tasks whose links were not read because they have no Project value.
  unscoped?:number;
};
// A loaded task and the project its links are read in (undefined for link tables without a scope column).
export type ScopedTask = { id:string; scope?:string };

const BATCH_SIZE = 50;
const MAX_ROWS_PER_BATCH = 5000;
// Dataverse "missing privilege" error code (0x80040220), signed and unsigned.
const PRIVILEGE_ERRORS = new Set([-2147220960, 2147746336]);

// Explains a failed read; a missing read privilege is named as such, any other failure keeps the Dataverse message.
export function describeReadError(error:unknown, table:string):{ kind:DependencyErrorKind; message:string } {
  const raw = error instanceof Error && error.message ? error.message
    : typeof error === "string" && error ? error
    : typeof (error as { message?:unknown })?.message === "string" ? String((error as { message:string }).message) : "";
  const code = Number((error as { errorCode?:unknown; code?:unknown } | undefined)?.errorCode ?? (error as { code?:unknown } | undefined)?.code);
  if (PRIVILEGE_ERRORS.has(code) || /prvRead|missing .*privilege|does not have .*privilege/i.test(raw)) {
    return { kind: "access", message: `You do not have permission to read dependency links (${table}). Ask an administrator for read access.${raw ? ` Dataverse: ${raw}` : ""}` };
  }
  return { kind: "read", message: raw || "The dependency rows could not be read." };
}

// Reads links for the loaded tasks with the signed-in user's permissions. Each task is queried once in its own project,
// links are kept by id so pages and projects never duplicate them, and answers that arrive after a reset are ignored.
export class DependencyLoader {
  private links = new Map<string,DependencyLink>();
  private skipped = new Map<string,SkippedLink>();
  private queried = new Set<string>();
  private pending = 0;
  private generation = 0;
  private error?:{ kind:DependencyErrorKind; message:string };
  private truncated = false;
  private source = "";
  private lastSkipWarning = "";

  constructor(private readonly webApi:WebApiLike, private readonly onChange:() => void, private readonly batchSize = BATCH_SIZE) {}

  reset():void {
    this.generation += 1;
    this.links.clear();
    this.skipped.clear();
    this.queried.clear();
    this.pending = 0;
    this.error = undefined;
    this.truncated = false;
  }

  // Tasks keep their own project, so a multi-project view reads each project's links and Load more never resets them.
  sync(source:LinkSource, tasks:ScopedTask[]):void {
    const sourceKey = `${source.kind}|${source.table}|${source.predecessorColumn}|${source.successorColumn}`;
    if (sourceKey !== this.source) {
      this.reset();
      this.source = sourceKey;
    }
    if (this.error) return;
    const fresh = new Map<string,ScopedTask>();
    tasks.forEach(task => {
      const entry = { id: normalizeId(task.id), ...(task.scope ? { scope: normalizeId(task.scope) } : {}) };
      const key = `${entry.scope ?? ""}|${entry.id}`;
      if (!this.queried.has(key)) fresh.set(key, entry);
    });
    const entries = Array.from(fresh.entries());
    for (let index = 0; index < entries.length; index += this.batchSize) {
      const batch = entries.slice(index, index + this.batchSize);
      batch.forEach(([key]) => this.queried.add(key));
      const ids = Array.from(new Set(batch.map(([, task]) => task.id)));
      const scopes = Array.from(new Set(batch.map(([, task]) => task.scope).filter((scope):scope is string => Boolean(scope))));
      void this.load(source, ids, scopes, this.generation);
    }
  }

  view():DependencyView {
    return {
      status: this.error ? "error" : this.pending > 0 ? "loading" : "ready",
      links: Array.from(this.links.values()),
      skipped: Array.from(this.skipped.values()),
      ...(this.error ? { message: this.error.message, errorKind: this.error.kind } : {}),
      ...(this.truncated ? { truncated: true } : {})
    };
  }

  private async load(source:LinkSource, batch:string[], scopes:string[], generation:number):Promise<void> {
    this.pending += 1;
    try {
      const fetchXml = buildLinkFetchXml(source, batch, scopes);
      const result = await this.webApi.retrieveMultipleRecords(source.table, `?fetchXml=${encodeURIComponent(fetchXml)}`, MAX_ROWS_PER_BATCH);
      if (generation !== this.generation) return;
      (result.entities ?? []).forEach(row => {
        const { link, skipped } = parseLinkRow(source, row);
        if (link) this.links.set(link.id, link);
        else if (skipped) this.skipped.set(skipped.id || `${this.skipped.size}`, skipped);
      });
      if (result.nextLink) this.truncated = true;
      this.warnSkipped();
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = describeReadError(error, source.table);
    } finally {
      if (generation === this.generation) {
        this.pending = Math.max(0, this.pending - 1);
        this.onChange();
      }
    }
  }

  private warnSkipped():void {
    const skipped = Array.from(this.skipped.values());
    const description = describeSkipped(skipped);
    if (!skipped.length || description === this.lastSkipWarning) return;
    this.lastSkipWarning = description;
    console.warn(`TaskGantt skipped ${skipped.length} dependency link(s): ${description}.`, skipped);
  }
}
