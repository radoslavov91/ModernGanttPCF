import { IInputs, IOutputs } from "./generated/ManifestTypes";
import * as React from "react";
import { DateFilter, Gantt, LicenseDebugInfo, LicenseState, SortState, StatusFilter, TaskItem } from "./src/Gantt";

type Column = ComponentFramework.PropertyHelper.DataSetApi.Column;
type ConditionExpression = ComponentFramework.PropertyHelper.DataSetApi.ConditionExpression;
type ConditionOperator = ComponentFramework.PropertyHelper.DataSetApi.Types.ConditionOperator;
type SortStatus = ComponentFramework.PropertyHelper.DataSetApi.SortStatus;

type FilterState = {
  status: StatusFilter;
  createdOn: DateFilter;
  dueDate: DateFilter;
};

interface ILicenseValidationResponse {
  licensed: boolean;
  reason?: string;
  licenseMode?: string;
  expiresOn?: string;
  status?: string;
}

const DATE_FILTER_OPERATORS: Record<Exclude<DateFilter, "all">, ConditionOperator> = {
  lastWeek: 19,
  thisWeek: 20,
  lastMonth: 22,
  thisMonth: 23
};

const LICENSE_CACHE_PREFIX = "modernGanttLicense";
const LICENSE_CACHE_SCHEMA_VERSION = 1;
const DATAVERSE_CACHE_VERSION = 1;
const SUPPORT_EMAIL = "support@simetrixconsult.com";

export class TaskGantt implements ComponentFramework.ReactControl<IInputs, IOutputs> {
  private context!: ComponentFramework.Context<IInputs>;
  private notifyOutputChanged?: () => void;
  private pageSizeConfigured = false;
  private filters: FilterState = { status: "all", createdOn: "all", dueDate: "all" };
  private sorting: SortState;
  private lastAppliedFilterSignature = "status:all:|createdOn:all|dueDate:all";
  private lastAppliedSortingSignature = "";
  private completedRawValue: string | undefined;
  private observedActiveRawValue: string | undefined;
  private lastStatusResolutionLogSignature = "";
  private licenseState: LicenseState = "checking";
  private licenseMessage = "Validating license...";
  private licenseDebugInfo?: LicenseDebugInfo;
  private activeLicenseFingerprint = "";
  private activeLicenseRequestId = 0;
  private licenseValidationInFlight = false;
  private activeLicenseAbortController?: AbortController;
  private forceLicenseRefresh = false;
  private licenseWatchdogTimer?: number;
  private dataverseCacheCheckedForKey = "";
  private dataverseCacheCheckInFlight = false;

  private static readonly BUILD_VERSION = "3.2.0";
  private static readonly CONTROL_CODE = "moderngantt";
  private static readonly LICENSE_ENDPOINT = "https://modern365timeline-license-fkh6gbgdhnchgyhj.westeurope-01.azurewebsites.net/api/validateLicense";

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void
  ): void {
    this.context = context;
    this.notifyOutputChanged = notifyOutputChanged;
    context.mode.trackContainerResize(true);
  }

  public updateView(context: ComponentFramework.Context<IInputs>): React.ReactElement {
    this.context = context;
    this.ensureLicenseValidation(context);

    const ds = context.parameters.tasks;
    if (!this.pageSizeConfigured) {
      ds.paging.setPageSize(10);
      this.pageSizeConfigured = true;
    }

    const scheduledStartColumn = this.resolveColumn(ds.columns, "scheduledstart");
    const createdOnColumn = this.resolveColumn(ds.columns, "createdon");
    const scheduledEndColumn = this.resolveColumn(ds.columns, "scheduledend");
    const ownerColumn = this.resolveColumn(ds.columns, "ownerid");
    const subjectColumn = this.resolveColumn(ds.columns, "subject");
    const stateColumn = this.resolveColumn(ds.columns, "statecode");
    if (this.filters.status === "all" && stateColumn && ds.sortedRecordIds.length) {
      this.observeStatusValues(ds, stateColumn);
    }

    const tasks: TaskItem[] = ds.sortedRecordIds.map((id: string) => {
      const r = ds.records[id];
      const value = (column?: Column) => column ? r.getValue(column.name) as string | Date | null : null;
      const formatted = (column?: Column) => column ? r.getFormattedValue(column.name) : "";
      const formattedState = formatted(stateColumn) || "Active";
      const status: TaskItem["status"] = formattedState.toLowerCase() === "completed" ? "Completed" : "Active";
      const scheduledStart = value(scheduledStartColumn);
      const createdOn = value(createdOnColumn);
      const startValue = scheduledStart || createdOn;
      return {
        recordId: id,
        name: formatted(subjectColumn) || "(Unnamed task)",
        assignedTo: formatted(ownerColumn) || "Unassigned",
        status,
        start: new Date(startValue as string | Date),
        due: new Date(value(scheduledEndColumn) as string | Date)
      };
    });

    const allocatedWidth = Number(context.mode.allocatedWidth) || 0;
    const allocatedHeight = Number(context.mode.allocatedHeight) || 0;

    return React.createElement(Gantt, {
      tasks,
      allocatedHeight,
      allocatedWidth,
      loading: ds.loading,
      filters: this.filters,
      sorting: this.sorting,
      licenseState: this.licenseState,
      licenseMessage: this.licenseMessage,
      licenseDebugInfo: this.licenseDebugInfo,
      onRevalidateLicense: () => this.revalidateLicense(),
      onFiltersChange: (filters: FilterState) => this.applyFilters(ds, filters),
      onSortChange: (sorting: SortState) => this.applySorting(ds, sorting),
      onOpen: (recordId: string) => ds.openDatasetItem(ds.records[recordId].getNamedReference()),
      onLoadMore: ds.paging.hasNextPage && !ds.loading ? () => ds.paging.loadNextPage() : undefined
    });
  }

  private ensureLicenseValidation(context: ComponentFramework.Context<IInputs>): void {
    const licenseKey = (context.parameters.licenseKey?.raw ?? "").trim();
    const organizationId = getOrganizationId();
    const environmentUrl = getEnvironmentUrl(context);
    const cacheKey = buildDataverseCacheKey(TaskGantt.CONTROL_CODE, organizationId, environmentUrl);
    const fingerprint = buildLocalCacheFingerprint(licenseKey, cacheKey);
    const requestInfo: LicenseDebugInfo = {
      endpoint: TaskGantt.LICENSE_ENDPOINT,
      request: {
        organizationId,
        environmentUrl,
        controlCode: TaskGantt.CONTROL_CODE,
        licenseKey: maskLicenseKey(licenseKey),
        version: TaskGantt.BUILD_VERSION
      }
    };

    if (!licenseKey) {
      this.logLicenseDebug("ensureLicenseValidation:return:missingLicenseKey", { cacheKeyPresent: Boolean(cacheKey) });
      this.setLicenseDebugInfo(requestInfo);
      this.setLicenseState("unlicensed", `This organization is not licensed for Modern Gantt. Enter a valid license key or contact ${SUPPORT_EMAIL}.`);
      return;
    }

    if (this.activeLicenseFingerprint === fingerprint && this.licenseValidationInFlight) {
      return;
    }

    if (this.activeLicenseFingerprint === fingerprint && this.licenseState !== "checking") {
      return;
    }

    const bypassCache = this.forceLicenseRefresh;
    this.forceLicenseRefresh = false;
    const cached = bypassCache ? null : readCachedLicenseValidation(fingerprint);
    if (cached) {
      this.clearLicenseWatchdog();
      this.activeLicenseFingerprint = fingerprint;
      this.licenseDebugInfo = buildLicenseDebugInfo(requestInfo, cached, true, "localStorage", 0);
      this.licenseState = cached.licensed ? "licensed" : "unlicensed";
      this.licenseMessage = cached.licensed ? "" : getLicenseFailureMessage(cached);
      this.requestControlRender();
      return;
    }

    if (this.dataverseCacheCheckInFlight) {
      this.logLicenseDebug("ensureLicenseValidation:return:dataverseCacheCheckInFlight");
      this.setLicenseState("checking", "Checking license cache...");
      return;
    }

    if (this.dataverseCacheCheckedForKey !== cacheKey && !bypassCache) {
      this.dataverseCacheCheckInFlight = true;
      this.setLicenseDebugInfo(requestInfo);
      this.setLicenseState("checking", "Checking license cache...");

      void readDataverseLicenseCache(context, cacheKey)
        .then((dataverseCacheResult) => {
          this.dataverseCacheCheckInFlight = false;
          this.dataverseCacheCheckedForKey = cacheKey;

          if (dataverseCacheResult) {
            writeCachedLicenseValidation(fingerprint, dataverseCacheResult);
            this.clearLicenseWatchdog();
            this.activeLicenseFingerprint = fingerprint;
            this.licenseValidationInFlight = false;
            this.licenseDebugInfo = buildLicenseDebugInfo(requestInfo, dataverseCacheResult, true, "dataverse", 0);
            this.licenseState = dataverseCacheResult.licensed ? "licensed" : "unlicensed";
            this.licenseMessage = dataverseCacheResult.licensed ? "" : getLicenseFailureMessage(dataverseCacheResult);
            this.requestControlRender();
            return undefined;
          }

          this.ensureLicenseValidation(this.context);
          this.requestControlRender();
          return undefined;
        })
        .catch((error: unknown) => {
          this.dataverseCacheCheckInFlight = false;
          this.dataverseCacheCheckedForKey = cacheKey;
          this.logLicenseDebug("dataverseCache:error", { error: getSafeErrorMessage(error) });
          this.ensureLicenseValidation(this.context);
          this.requestControlRender();
          return undefined;
        });
      return;
    }

    if (this.activeLicenseAbortController) {
      this.activeLicenseAbortController.abort();
    }

    this.activeLicenseFingerprint = fingerprint;
    this.licenseValidationInFlight = true;
    this.setLicenseDebugInfo(requestInfo);
    this.setLicenseState("checking", "Validating license...");
    this.startLicenseWatchdog(`License validation did not complete within 15 seconds. Click Revalidate License or contact ${SUPPORT_EMAIL}.`);
    const requestId = ++this.activeLicenseRequestId;
    const abortController = new AbortController();
    this.activeLicenseAbortController = abortController;
    const timeoutId = window.setTimeout(() => abortController.abort(), 10000);
    const validationStartedAt = new Date().toISOString();
    const validationStartedPerf = performance.now();
    const requestFingerprint = fingerprint;

    void validateLicenseRequest({
      endpoint: TaskGantt.LICENSE_ENDPOINT,
      licenseKey,
      organizationId,
      environmentUrl,
      controlCode: TaskGantt.CONTROL_CODE,
      version: TaskGantt.BUILD_VERSION,
      signal: abortController.signal
    })
      .then((result) => {
        try {
          if (requestId !== this.activeLicenseRequestId && requestFingerprint !== this.activeLicenseFingerprint) {
            this.logLicenseDebug("validate:ignored:stale", { requestId, activeLicenseRequestId: this.activeLicenseRequestId });
            return undefined;
          }

          window.clearTimeout(timeoutId);
          this.licenseValidationInFlight = false;
          this.activeLicenseAbortController = undefined;
          this.clearLicenseWatchdog();
          const normalizedResult = normalizeEnvironmentLicenseResult(result);
          writeCachedLicenseValidation(fingerprint, normalizedResult);
          void upsertDataverseLicenseCache(this.context, cacheKey, requestInfo.request, normalizedResult);
          this.licenseDebugInfo = buildLicenseDebugInfo(
            requestInfo,
            normalizedResult,
            false,
            "azure",
            Math.round(performance.now() - validationStartedPerf),
            validationStartedAt,
            new Date().toISOString()
          );
          this.licenseState = normalizedResult.licensed ? "licensed" : "unlicensed";
          this.licenseMessage = normalizedResult.licensed ? "" : getLicenseFailureMessage(normalizedResult);
          this.requestControlRender();
        } catch (error) {
          this.logLicenseDebug("validate:applyResult:error", { error: getSafeErrorMessage(error) });
          this.licenseValidationInFlight = false;
          this.activeLicenseAbortController = undefined;
          this.clearLicenseWatchdog();
          this.licenseState = "error";
          this.licenseMessage = `License validation succeeded, but the control failed to apply the result. Contact ${SUPPORT_EMAIL}.`;
          this.requestControlRender();
        }
        return undefined;
      })
      .catch((error: unknown) => {
        this.logLicenseDebug("validate:error", {
          error: getSafeErrorMessage(error),
          requestId,
          activeLicenseRequestId: this.activeLicenseRequestId
        });

        if (requestId !== this.activeLicenseRequestId && requestFingerprint !== this.activeLicenseFingerprint) {
          this.logLicenseDebug("validate:error:ignored:stale", { requestId, activeLicenseRequestId: this.activeLicenseRequestId });
          return undefined;
        }

        window.clearTimeout(timeoutId);
        this.licenseValidationInFlight = false;
        this.activeLicenseAbortController = undefined;
        this.clearLicenseWatchdog();
        const errorMessage = getLicenseErrorMessage(error, TaskGantt.LICENSE_ENDPOINT) ?? `Unable to validate the Modern Gantt license. Contact ${SUPPORT_EMAIL}.`;
        this.licenseDebugInfo = {
          ...requestInfo,
          response: {
            error: getLicenseErrorMessage(error, TaskGantt.LICENSE_ENDPOINT) ?? "Unknown license validation error.",
            cacheUsed: false,
            cacheSource: "azure",
            validationStartedAt,
            validationFinishedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - validationStartedPerf)
          }
        };
        this.licenseState = "error";
        this.licenseMessage = errorMessage;
        this.requestControlRender();
        return undefined;
      });
  }

  private revalidateLicense(): void {
    const licenseKey = (this.context?.parameters?.licenseKey?.raw ?? "").trim();
    const organizationId = getOrganizationId();
    const environmentUrl = getEnvironmentUrl(this.context);
    const cacheKey = buildDataverseCacheKey(TaskGantt.CONTROL_CODE, organizationId, environmentUrl);
    const fingerprint = buildLocalCacheFingerprint(licenseKey, cacheKey);

    this.clearLicenseWatchdog();
    if (this.activeLicenseAbortController) {
      this.activeLicenseAbortController.abort();
      this.activeLicenseAbortController = undefined;
    }

    clearAllLicenseValidationCache();
    clearCachedLicenseValidation(fingerprint);
    this.licenseValidationInFlight = false;
    this.activeLicenseFingerprint = "";
    this.activeLicenseRequestId += 1;
    this.dataverseCacheCheckedForKey = "";
    this.forceLicenseRefresh = true;
    this.licenseMessage = "Revalidating license...";
    this.licenseState = "checking";
    this.setLicenseDebugInfo({
      endpoint: TaskGantt.LICENSE_ENDPOINT,
      request: {
        organizationId,
        environmentUrl,
        controlCode: TaskGantt.CONTROL_CODE,
        licenseKey: maskLicenseKey(licenseKey),
        version: TaskGantt.BUILD_VERSION
      },
      response: {
        reason: "manual_revalidate_requested",
        cacheUsed: false,
        validationStartedAt: new Date().toISOString()
      }
    });
    this.requestControlRender();
    this.ensureLicenseValidation(this.context);
  }

  private resolveColumn(columns: Column[], propertySetAlias: string): Column | undefined {
    return columns.find(column => column.alias === propertySetAlias) || columns.find(column => column.name === propertySetAlias);
  }

  private observeStatusValues(ds: ComponentFramework.PropertyTypes.DataSet, stateColumn: Column): void {
    ds.sortedRecordIds.forEach((id: string) => {
      const record = ds.records[id];
      const rawValue = record.getValue(stateColumn.name);
      if (rawValue === null || rawValue === undefined) return;

      const formattedValue = (record.getFormattedValue(stateColumn.name) || "").trim().toLowerCase();
      if ((formattedValue === "active" || formattedValue === "open") && !this.observedActiveRawValue) {
        this.observedActiveRawValue = String(rawValue);
      }
      if (formattedValue === "completed" && !this.completedRawValue) {
        this.completedRawValue = String(rawValue);
      }
    });

    this.logStatusResolution(stateColumn.name);
  }

  private logStatusResolution(statusColumnName: string): void {
    const signature = `${statusColumnName}|${this.observedActiveRawValue || ""}|${this.completedRawValue || ""}`;
    if (signature === this.lastStatusResolutionLogSignature) return;
    this.lastStatusResolutionLogSignature = signature;
    if (typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production") {
      console.info("TaskGantt status resolution", {
        statusColumnName,
        activeRawValue: this.observedActiveRawValue,
        completedRawValue: this.completedRawValue
      });
    }
  }

  private applyFilters(ds: ComponentFramework.PropertyTypes.DataSet, filters: FilterState): void {
    const signature = this.getFilterSignature(filters);
    if (signature === this.lastAppliedFilterSignature) return;
    const conditions = this.buildFilterConditions(ds.columns, filters);

    this.filters = filters;
    this.lastAppliedFilterSignature = signature;

    if (!conditions.length) {
      ds.filtering.clearFilter();
    } else {
      ds.filtering.setFilter({
        filterOperator: 0,
        conditions
      });
    }

    ds.paging.reset();
    ds.refresh();
  }

  private buildFilterConditions(columns: Column[], filters: FilterState): ConditionExpression[] {
    const conditions: ConditionExpression[] = [];
    const stateColumn = this.resolveColumn(columns, "statecode");
    const createdOnColumn = this.resolveColumn(columns, "createdon");
    const dueDateColumn = this.resolveColumn(columns, "scheduledend");

    if (filters.status !== "all" && !stateColumn) {
      console.warn("TaskGantt could not resolve the mapped Status dataset column. Status condition was skipped.");
    }

    if (filters.status !== "all" && stateColumn) {
      if (!this.completedRawValue) {
        console.warn(`TaskGantt could not resolve a raw Dataverse value for Completed. The ${filters.status} status filter was skipped.`);
      } else {
        if (filters.status === "completed") {
          conditions.push({
            attributeName: stateColumn.name,
            conditionOperator: 0,
            value: this.completedRawValue
          });
        } else {
          conditions.push({
            attributeName: stateColumn.name,
            conditionOperator: 1,
            value: this.completedRawValue
          });
          if (filters.status === "overdue") {
            if (!dueDateColumn) {
              console.warn("TaskGantt could not resolve the mapped Due Date dataset column. Overdue condition was skipped.");
            } else {
              conditions.push({
                attributeName: dueDateColumn.name,
                conditionOperator: 3,
                value: new Date().toISOString()
              });
            }
          }
        }
      }
    }

    this.addDateCondition(conditions, createdOnColumn, filters.createdOn);
    this.addDateCondition(conditions, dueDateColumn, filters.dueDate);
    return conditions;
  }

  private addDateCondition(conditions: ConditionExpression[], column: Column | undefined, filter: DateFilter): void {
    if (filter === "all" || !column) return;
    conditions.push({
      attributeName: column.name,
      conditionOperator: DATE_FILTER_OPERATORS[filter],
      value: ""
    });
  }

  private getFilterSignature(filters: FilterState): string {
    const completedSignature = filters.status === "all" ? "" : this.completedRawValue || "";
    return `status:${filters.status}:${completedSignature}|createdOn:${filters.createdOn}|dueDate:${filters.dueDate}`;
  }

  private applySorting(ds: ComponentFramework.PropertyTypes.DataSet, sorting: SortState): void {
    const columns: Record<NonNullable<SortState>["key"], Column | undefined> = {
      task: this.resolveColumn(ds.columns, "subject"),
      assignedTo: this.resolveColumn(ds.columns, "ownerid"),
      status: this.resolveColumn(ds.columns, "statecode"),
      startDate: this.resolveColumn(ds.columns, "scheduledstart"),
      dueDate: this.resolveColumn(ds.columns, "scheduledend")
    };
    const column = sorting ? columns[sorting.key] : undefined;

    if (sorting && !column) {
      console.warn(`TaskGantt could not resolve the mapped column for ${sorting.key}. Sorting was skipped.`);
      return;
    }

    const signature = sorting && column ? `${column.name}:${sorting.direction}` : "";
    if (signature === this.lastAppliedSortingSignature) return;

    this.sorting = sorting;
    this.lastAppliedSortingSignature = signature;
    ds.sorting = sorting && column ? [{
      name: column.name,
      sortDirection: sorting.direction === "asc" ? 0 : 1
    } as SortStatus] : [];
    ds.paging.reset();
    ds.refresh();
  }

  private logLicenseDebug(step: string, data?: unknown): void {
    if (!shouldLogLicenseStep(step)) {
      return;
    }

    try {
      console.log("[ModernGantt][License]", step, data ?? "");
    } catch {
      // ignore
    }
  }

  private requestControlRender(): void {
    try {
      if (this.context?.factory?.requestRender) {
        this.context.factory.requestRender();
        return;
      }
    } catch {
      // fall back below
    }

    this.notifyOutputChanged?.();
  }

  private clearLicenseWatchdog(): void {
    if (this.licenseWatchdogTimer) {
      window.clearTimeout(this.licenseWatchdogTimer);
      this.licenseWatchdogTimer = undefined;
    }
  }

  private startLicenseWatchdog(message: string): void {
    this.clearLicenseWatchdog();

    this.licenseWatchdogTimer = window.setTimeout(() => {
      this.logLicenseDebug("watchdog:fired", {
        licenseState: this.licenseState,
        licenseValidationInFlight: this.licenseValidationInFlight
      });

      if (this.licenseState === "checking") {
        this.licenseValidationInFlight = false;
        this.activeLicenseAbortController?.abort();
        this.activeLicenseAbortController = undefined;
        this.licenseState = "error";
        this.licenseMessage = message;
        this.licenseDebugInfo = {
          ...(this.licenseDebugInfo ?? {
            endpoint: TaskGantt.LICENSE_ENDPOINT,
            request: {
              organizationId: getOrganizationId(),
              environmentUrl: getEnvironmentUrl(this.context),
              controlCode: TaskGantt.CONTROL_CODE,
              licenseKey: maskLicenseKey((this.context?.parameters?.licenseKey?.raw ?? "").trim()),
              version: TaskGantt.BUILD_VERSION
            }
          }),
          response: {
            ...(this.licenseDebugInfo?.response ?? {}),
            error: "license_validation_watchdog_timeout",
            reason: "license_validation_timeout",
            validationFinishedAt: new Date().toISOString(),
            cacheUsed: false
          }
        };

        this.requestControlRender();
      }
    }, 15000);
  }

  private setLicenseDebugInfo(info: LicenseDebugInfo | undefined): void {
    this.licenseDebugInfo = info;
    this.requestControlRender();
  }

  private setLicenseState(state: LicenseState, message: string): void {
    if (this.licenseState === state && this.licenseMessage === message) {
      return;
    }

    this.licenseState = state;
    this.licenseMessage = message;
    this.requestControlRender();
  }

  public getOutputs(): IOutputs { return {}; }

  public destroy(): void {
    this.clearLicenseWatchdog();
    this.activeLicenseAbortController?.abort();
  }
}

function buildLicenseDebugInfo(
  requestInfo: LicenseDebugInfo,
  result: ILicenseValidationResponse,
  cacheUsed: boolean,
  cacheSource: "localStorage" | "dataverse" | "azure",
  durationMs: number,
  validationStartedAt?: string,
  validationFinishedAt?: string
): LicenseDebugInfo {
  return {
    ...requestInfo,
    response: {
      licensed: result.licensed,
      reason: result.reason,
      licenseMode: result.licenseMode,
      expiresOn: result.expiresOn,
      status: result.status,
      cacheUsed,
      cacheSource,
      validationStartedAt,
      validationFinishedAt,
      durationMs
    }
  };
}

async function validateLicenseRequest(request: {
  endpoint: string;
  licenseKey: string;
  organizationId: string;
  environmentUrl: string;
  controlCode: string;
  version: string;
  signal?: AbortSignal;
}): Promise<ILicenseValidationResponse> {
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    signal: request.signal,
    body: JSON.stringify({
      licenseKey: request.licenseKey,
      organizationId: request.organizationId,
      environmentUrl: request.environmentUrl,
      controlCode: request.controlCode,
      version: request.version
    })
  });

  const payload = (await response.json().catch(() => ({}))) as Partial<ILicenseValidationResponse>;
  if (!response.ok) {
    throw new Error(payload.reason ?? `License validation failed with status ${response.status}.`);
  }

  return {
    licensed: Boolean(payload.licensed),
    reason: payload.reason,
    licenseMode: payload.licenseMode,
    expiresOn: payload.expiresOn,
    status: payload.status
  };
}

function normalizeEnvironmentLicenseResult(result: ILicenseValidationResponse): ILicenseValidationResponse {
  const licenseMode = String(result.licenseMode ?? "environment").trim().toLowerCase();
  if (licenseMode !== "environment") {
    return {
      ...result,
      licensed: false,
      licenseMode,
      reason: "invalid_license_mode"
    };
  }

  return {
    ...result,
    licenseMode: "environment",
    reason: result.reason || (result.licensed ? "valid" : "license_not_found")
  };
}

function buildLocalCacheFingerprint(licenseKey: string, cacheKey: string): string {
  return `v${LICENSE_CACHE_SCHEMA_VERSION}:${hashString(`${licenseKey}|${cacheKey}`)}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}

function maskLicenseKey(licenseKey: string): string {
  if (!licenseKey) {
    return "";
  }

  return licenseKey.length <= 4 ? "****" : `****${licenseKey.slice(-4)}`;
}

function buildDataverseCacheKey(controlCode: string, organizationId: string, environmentUrl: string): string {
  return `${controlCode}|${organizationId}|${environmentUrl}`;
}

async function readDataverseLicenseCache(
  context: ComponentFramework.Context<IInputs>,
  cacheKey: string
): Promise<ILicenseValidationResponse | null> {
  try {
    const escapedCacheKey = cacheKey.replace(/'/g, "''");
    const query = [
      "?$select=simetrix_licensed,simetrix_reason,simetrix_licensemode,simetrix_expireson,simetrix_validationexpireson,simetrix_cacheversion,simetrix_isactive",
      `&$filter=simetrix_cachekey eq '${escapedCacheKey}' and simetrix_isactive eq true`,
      "&$top=1"
    ].join("");

    const result = await context.webAPI.retrieveMultipleRecords("simetrix_licensecache", query);
    const record = result.entities[0];
    if (!record) {
      const inactiveQuery = [
        "?$select=simetrix_isactive",
        `&$filter=simetrix_cachekey eq '${escapedCacheKey}'`,
        "&$top=1"
      ].join("");
      const inactiveResult = await context.webAPI.retrieveMultipleRecords("simetrix_licensecache", inactiveQuery);
      logDataverseCacheInvalid(inactiveResult.entities[0] ? "inactive" : "not_found");
      return null;
    }

    if (record.simetrix_isactive !== true) {
      logDataverseCacheInvalid("inactive");
      return null;
    }

    if (record.simetrix_cacheversion !== DATAVERSE_CACHE_VERSION) {
      logDataverseCacheInvalid("wrong_cache_version");
      return null;
    }

    if (typeof record.simetrix_licensed !== "boolean") {
      logDataverseCacheInvalid("licensed_not_boolean");
      return null;
    }

    const licensed = record.simetrix_licensed;
    const reason = String(record.simetrix_reason ?? "").trim();
    if (!reason) {
      logDataverseCacheInvalid("missing_reason");
      return null;
    }

    const licenseMode = String(record.simetrix_licensemode ?? "").trim().toLowerCase();
    if (licenseMode !== "environment") {
      logDataverseCacheInvalid("invalid_license_mode");
      return null;
    }

    if (!record.simetrix_validationexpireson) {
      logDataverseCacheInvalid("missing_validation_expires_on");
      return null;
    }

    const validationExpiresOn = new Date(String(record.simetrix_validationexpireson)).getTime();
    if (Number.isNaN(validationExpiresOn)) {
      logDataverseCacheInvalid("malformed");
      return null;
    }

    if (validationExpiresOn <= Date.now()) {
      logDataverseCacheInvalid("expired");
      return null;
    }

    if (licensed && reason !== "valid") {
      logDataverseCacheInvalid("licensed_reason_not_valid");
      return null;
    }

    return {
      licensed,
      reason,
      licenseMode,
      expiresOn: record.simetrix_expireson ? String(record.simetrix_expireson) : undefined,
      status: "cached"
    };
  } catch {
    logDataverseCacheInvalid("malformed");
    return null;
  }
}

async function upsertDataverseLicenseCache(
  context: ComponentFramework.Context<IInputs>,
  cacheKey: string,
  request: LicenseDebugInfo["request"],
  result: ILicenseValidationResponse
): Promise<void> {
  try {
    logLicenseConsole("dataverseCache:upsert:start");
    const escapedCacheKey = cacheKey.replace(/'/g, "''");
    const query = [
      "?$select=simetrix_licensecacheid,simetrix_lastvalidatedon,createdon",
      `&$filter=simetrix_cachekey eq '${escapedCacheKey}' and simetrix_isactive eq true`,
      "&$orderby=simetrix_lastvalidatedon desc,createdon desc"
    ].join("");
    const existing = await context.webAPI.retrieveMultipleRecords("simetrix_licensecache", query);
    const activeCacheRecords = existing.entities
      .map((entity) => asString(entity.simetrix_licensecacheid))
      .filter(Boolean);
    const existingId = activeCacheRecords[0] ?? "";
    const now = new Date().toISOString();
    const validationExpiresOn = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const payload = {
      simetrix_name: `Modern Gantt License Cache - ${request.organizationId}`,
      simetrix_cachekey: cacheKey,
      simetrix_controlcode: request.controlCode,
      simetrix_organizationid: request.organizationId,
      simetrix_environmenturl: request.environmentUrl,
      simetrix_licensed: result.licensed,
      simetrix_reason: result.reason ?? "",
      simetrix_licensemode: "environment",
      simetrix_expireson: result.expiresOn ?? null,
      simetrix_validationexpireson: validationExpiresOn,
      simetrix_lastvalidatedon: now,
      simetrix_servervalidatedon: now,
      simetrix_cacheversion: DATAVERSE_CACHE_VERSION,
      simetrix_isactive: true
    };

    if (existingId) {
      if (activeCacheRecords.length > 1) {
        logDataverseCacheInvalid("duplicate_active_cache_records");
      }

      logLicenseConsole("dataverseCache:upsert:update", { activeRecords: activeCacheRecords.length });
      await context.webAPI.updateRecord("simetrix_licensecache", existingId, payload);
      await deactivateDuplicateDataverseLicenseCacheRecords(context, activeCacheRecords.slice(1));
      logLicenseConsole("dataverseCache:upsert:success", { operation: "update" });
      return;
    }

    logLicenseConsole("dataverseCache:upsert:create");
    await context.webAPI.createRecord("simetrix_licensecache", payload);
    logLicenseConsole("dataverseCache:upsert:success", { operation: "create" });
  } catch (error) {
    logLicenseConsole("dataverseCache:upsert:error", { error: getSafeErrorMessage(error) });
  }
}

async function deactivateDuplicateDataverseLicenseCacheRecords(
  context: ComponentFramework.Context<IInputs>,
  duplicateIds: string[]
): Promise<void> {
  await Promise.all(
    duplicateIds.map(async (duplicateId) => {
      try {
        await context.webAPI.updateRecord("simetrix_licensecache", duplicateId, {
          simetrix_isactive: false
        });
      } catch (error) {
        logLicenseConsole("dataverseCache:upsert:error", { error: getSafeErrorMessage(error) });
      }
    })
  );
}

function logDataverseCacheInvalid(reason: string): void {
  logLicenseConsole("dataverseCache:invalid", { reason });
}

function logLicenseConsole(step: string, data?: unknown): void {
  if (!shouldLogLicenseStep(step)) {
    return;
  }

  try {
    console.log("[ModernGantt][License]", step, data ?? "");
  } catch {
    // ignore
  }
}

function shouldLogLicenseStep(step: string): boolean {
  return step.includes(":error") || step.includes("watchdog") || step.includes("invalid") || step.includes("ignored:stale");
}

function getEnvironmentUrl(context: ComponentFramework.Context<IInputs>): string {
  void context;
  const normalizedOrigin = window.location.origin.toLowerCase().replace(/\/+$/, "");

  try {
    const url = new URL(normalizedOrigin);
    const match = /^([^.]+)\.(api\.)?crm(\d+)?\.dynamics\.com$/i.exec(url.hostname);
    if (match && !match[2]) {
      const instance = match[1];
      const region = match[3] ?? "";
      return `${url.protocol}//${instance}.api.crm${region}.dynamics.com`;
    }
  } catch {
    return normalizedOrigin;
  }

  return normalizedOrigin;
}

function getOrganizationId(): string {
  const globalContext = tryGetGlobalContext();
  const organizationId = globalContext?.organizationSettings?.organizationId;
  return typeof organizationId === "string" ? organizationId.replace(/[{}]/g, "") : "";
}

function tryGetGlobalContext():
  | {
      organizationSettings?: {
        organizationId?: string;
      };
    }
  | undefined {
  try {
    const context = (window.parent as { Xrm?: { Utility?: { getGlobalContext?: () => unknown } } } | undefined)?.Xrm?.Utility?.getGlobalContext?.();
    return context as { organizationSettings?: { organizationId?: string } } | undefined;
  } catch {
    return undefined;
  }
}

function readCachedLicenseValidation(fingerprint: string): ILicenseValidationResponse | null {
  if (typeof window === "undefined" || !window.localStorage || !fingerprint) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(`${LICENSE_CACHE_PREFIX}:${fingerprint}`);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as ILicenseValidationResponse & { cachedUntil?: string; schemaVersion?: number };
    if (parsed.schemaVersion !== LICENSE_CACHE_SCHEMA_VERSION) {
      window.localStorage.removeItem(`${LICENSE_CACHE_PREFIX}:${fingerprint}`);
      return null;
    }

    if (typeof parsed.licensed !== "boolean") {
      window.localStorage.removeItem(`${LICENSE_CACHE_PREFIX}:${fingerprint}`);
      return null;
    }

    if (String(parsed.licenseMode ?? "").toLowerCase() !== "environment") {
      window.localStorage.removeItem(`${LICENSE_CACHE_PREFIX}:${fingerprint}`);
      return null;
    }

    if (!parsed.reason) {
      window.localStorage.removeItem(`${LICENSE_CACHE_PREFIX}:${fingerprint}`);
      return null;
    }

    if (!parsed.cachedUntil || new Date(parsed.cachedUntil).getTime() < Date.now()) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function writeCachedLicenseValidation(fingerprint: string, result: ILicenseValidationResponse): void {
  if (typeof window === "undefined" || !window.localStorage || !fingerprint) {
    return;
  }

  const cachedUntil = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  window.localStorage.setItem(
    `${LICENSE_CACHE_PREFIX}:${fingerprint}`,
    JSON.stringify({
      ...normalizeEnvironmentLicenseResult(result),
      schemaVersion: LICENSE_CACHE_SCHEMA_VERSION,
      cachedUntil
    })
  );
}

function clearCachedLicenseValidation(fingerprint: string): void {
  if (typeof window === "undefined" || !window.localStorage || !fingerprint) {
    return;
  }

  try {
    window.localStorage.removeItem(`${LICENSE_CACHE_PREFIX}:${fingerprint}`);
  } catch {
    // ignore cache clear failures
  }
}

function clearAllLicenseValidationCache(): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith(`${LICENSE_CACHE_PREFIX}:`))
      .forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // ignore cache clear failures
  }
}

function getLicenseErrorMessage(error: unknown, endpoint: string): string | null {
  if (error instanceof Error && error.message) {
    const normalized = error.message.trim().toLowerCase();
    if (normalized === "failed to fetch" || normalized.includes("networkerror")) {
      return `License validation failed due to a network or CORS error while calling ${endpoint}. Check browser Network tab for validateLicense OPTIONS/POST failures.`;
    }

    return `License validation failed. ${error.message}`;
  }

  if (typeof error === "string" && error) {
    const normalized = error.trim().toLowerCase();
    if (normalized === "failed to fetch" || normalized.includes("networkerror")) {
      return `License validation failed due to a network or CORS error while calling ${endpoint}. Check browser Network tab for validateLicense OPTIONS/POST failures.`;
    }

    return `License validation failed. ${error}`;
  }

  return null;
}

function getLicenseFailureMessage(result?: Partial<ILicenseValidationResponse>): string {
  switch (result?.reason?.toLowerCase()) {
    case "invalid_license_key":
      return `The provided license key is invalid for this Dynamics 365 environment. Contact ${SUPPORT_EMAIL}.`;
    case "invalid_license_mode":
      return `The provided license is not valid for Modern Gantt environment licensing. Contact ${SUPPORT_EMAIL}.`;
    case "license_not_found":
      return `This license key is not activated for this Dynamics 365 environment. Check the organization ID and environment URL, or contact ${SUPPORT_EMAIL}.`;
    case "license_expired":
      return `The Modern Gantt license for this organization has expired. Contact ${SUPPORT_EMAIL}.`;
    case "license_revoked":
      return `The Modern Gantt license for this organization has been revoked. Contact ${SUPPORT_EMAIL}.`;
    case "license_pending":
      return `The Modern Gantt license for this organization is pending activation. Contact ${SUPPORT_EMAIL}.`;
    default:
      return `This organization is not licensed for Modern Gantt. Contact ${SUPPORT_EMAIL}.`;
  }
}

function getSafeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "Unknown error";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
