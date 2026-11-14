import { normalizeId } from "./fieldMap";
import { buildLinkFetchXml, DependencyLink, describeSkipped, LinkSource, parseLinkRow, SkippedLink } from "./dependencies";

export type WebApiLike = {
  retrieveMultipleRecords(entityType:string, options?:string, maxPageSize?:number):Promise<{ entities:Record<string,unknown>[]; nextLink?:string }>;
};
export type DependencyStatus = "loading" | "ready" | "error";
export type DependencyView = {
  status:DependencyStatus;
  links:DependencyLink[];
  skipped:SkippedLink[];
  message?:string;
  // A batch returned more rows than one page; some links may be missing.
  truncated?:boolean;
};

const BATCH_SIZE = 50;
const MAX_ROWS_PER_BATCH = 5000;

// Reads links for the loaded tasks with the signed-in user's permissions. Each task id is queried once per scope, links
// are kept by id so pages never duplicate them, and answers that arrive after a reset are ignored.
export class DependencyLoader {
  private links = new Map<string,DependencyLink>();
  private skipped = new Map<string,SkippedLink>();
  private queried = new Set<string>();
  private pending = 0;
  private generation = 0;
  private error?:string;
  private truncated = false;
  private scope = "";
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

  sync(source:LinkSource, scopeId:string|undefined, taskIds:string[]):void {
    const scope = `${source.kind}|${source.table}|${source.predecessorColumn}|${source.successorColumn}|${scopeId ?? ""}`;
    if (scope !== this.scope) {
      this.reset();
      this.scope = scope;
    }
    if (this.error) return;
    const fresh = Array.from(new Set(taskIds.map(normalizeId))).filter(id => !this.queried.has(id));
    for (let index = 0; index < fresh.length; index += this.batchSize) {
      const batch = fresh.slice(index, index + this.batchSize);
      batch.forEach(id => this.queried.add(id));
      void this.load(source, scopeId, batch, this.generation);
    }
  }

  view():DependencyView {
    return {
      status: this.error ? "error" : this.pending > 0 ? "loading" : "ready",
      links: Array.from(this.links.values()),
      skipped: Array.from(this.skipped.values()),
      ...(this.error ? { message: this.error } : {}),
      ...(this.truncated ? { truncated: true } : {})
    };
  }

  private async load(source:LinkSource, scopeId:string|undefined, batch:string[], generation:number):Promise<void> {
    this.pending += 1;
    try {
      const fetchXml = buildLinkFetchXml(source, batch, scopeId);
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
      this.error = error instanceof Error && error.message ? error.message : typeof error === "string" && error ? error : "The dependency rows could not be read.";
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
