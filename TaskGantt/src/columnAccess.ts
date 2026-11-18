// Read-side column permissions for search and filters, from Modern Smart Grid's ColumnSecurity (2.2.2). Model-driven
// datasets do not expose the Canvas-only getColumnInfo contract, so security comes from supported Web API metadata and
// RetrievePrincipalAttributePrivileges. Anything that cannot be verified is treated as not permitted.
export type ColumnAccessState = "allowed" | "denied" | "unknown";
type Attribute = { LogicalName:string; MetadataId:string; IsSecured:boolean; IsValidForAdvancedFind?:{ Value?:boolean } | boolean };
type Privilege = { AttributeId:string; CanRead:number };
type Json = Record<string,unknown>;

const guid = (value:string):string => {
  const id = value.replace(/[{}]/g, "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid security principal.");
  return id;
};

export class ColumnAccess {
  private attributes?:Map<string,Attribute>;
  private privileges?:Privilege[];
  private loading?:Promise<void>;

  constructor(private readonly table:string, private readonly user:string, private readonly read:(path:string) => Promise<Json>, private readonly changed:() => void) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error("Invalid security table.");
  }

  private async rows(path:string):Promise<Json[]> {
    const result:Json[] = [];
    let next:string|undefined = path;
    while (next) {
      const page = await this.read(next);
      if (!Array.isArray(page.value)) throw new Error("Incomplete column metadata response.");
      result.push(...page.value as Json[]);
      next = page["@odata.nextLink"] as string|undefined;
    }
    return result;
  }

  // Loads once per instance; a failure stays unknown (nothing is offered) until the control is reloaded.
  load():Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        const rows = await this.rows(`EntityDefinitions(LogicalName='${this.table}')/Attributes?$select=LogicalName,MetadataId,IsSecured,IsValidForAdvancedFind`);
        this.attributes = new Map(rows.filter(row => typeof row.IsSecured === "boolean").map(row => [String(row.LogicalName).toLowerCase(), row as unknown as Attribute]));
        if (!Array.from(this.attributes.values()).some(attribute => attribute.IsSecured)) return;
        const response = await this.read(`systemusers(${guid(this.user)})/Microsoft.Dynamics.CRM.RetrievePrincipalAttributePrivileges()`);
        if (!Array.isArray(response.AttributePrivileges)) throw new Error("Column privileges unavailable.");
        this.privileges = response.AttributePrivileges as Privilege[];
      })().catch(() => undefined).then(() => { this.settled = true; this.changed(); });
    }
    return this.loading;
  }

  private settled = false;

  // The check finished without usable column metadata, so nothing can be offered.
  get failed():boolean {
    return this.settled && !this.attributes;
  }

  // Filtering is permitted when the column is searchable and the user can read it for every row (organization-level
  // read on a secured column). Record-level shares cannot cover a query over all pages, so they do not count.
  canFilter(field:string):ColumnAccessState {
    const attribute = this.attributes?.get(field.toLowerCase());
    if (!this.attributes) return "unknown";
    if (!attribute) return "denied";
    const searchable = typeof attribute.IsValidForAdvancedFind === "boolean" ? attribute.IsValidForAdvancedFind : attribute.IsValidForAdvancedFind?.Value;
    if (searchable === false) return "denied";
    if (!attribute.IsSecured) return "allowed";
    if (!this.privileges) return "unknown";
    return this.privileges.some(privilege => privilege.AttributeId.toLowerCase() === attribute.MetadataId.toLowerCase() && privilege.CanRead === 4) ? "allowed" : "denied";
  }

  secured(field:string):boolean|undefined {
    return this.attributes?.get(field.toLowerCase())?.IsSecured;
  }
}

// Dataverse client URL from the PCF page context or the model-driven host (Modern Smart Grid lookupBinding.ts).
export function metadataClientUrl(context:unknown):string|undefined {
  type Host = { Xrm?:{ Utility?:{ getGlobalContext?:() => { getClientUrl?:() => string } }; Page?:{ context?:{ getClientUrl?:() => string } } } };
  let clientUrl:string|undefined;
  try { clientUrl = (context as { page?:{ getClientUrl?:() => string } }).page?.getClientUrl?.(); } catch { clientUrl = undefined; }
  if (!clientUrl && typeof window !== "undefined") {
    const host = window as unknown as Host;
    try { clientUrl = host.Xrm?.Utility?.getGlobalContext?.().getClientUrl?.() || host.Xrm?.Page?.context?.getClientUrl?.(); } catch { clientUrl = undefined; }
    if (!clientUrl) {
      try { clientUrl = (window.parent as unknown as Host | undefined)?.Xrm?.Utility?.getGlobalContext?.().getClientUrl?.(); }
      catch { /* A cross-origin host cannot supply Dataverse metadata access. */ }
    }
  }
  return clientUrl ? clientUrl.replace(/\/+$/, "") : undefined;
}

// Same-origin, read-only Web API GET confined to the Dataverse API base.
export function webApiReader(clientUrl:string):(path:string) => Promise<Json> {
  const base = `${clientUrl}/api/data/v9.2/`;
  return async path => {
    const url = new URL(path, base);
    if (!url.href.startsWith(base)) throw new Error("Unexpected metadata URL.");
    const response = await fetch(url.href, { credentials: "same-origin", headers: { Accept: "application/json", "OData-Version": "4.0", "OData-MaxVersion": "4.0" } });
    if (!response.ok) throw new Error("Column metadata could not be read.");
    return await response.json() as Json;
  };
}
