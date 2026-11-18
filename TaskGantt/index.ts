import { IInputs, IOutputs } from "./generated/ManifestTypes";
import * as React from "react";
import { cleanupTaskGanttOverlays, DateFilter, Gantt, LicenseDebugInfo, LicenseState, SortState, sortTasksForDisplay, StatusFilter, TaskItem } from "./src/Gantt";
import { buildLayout, ColumnLike, CompletionConfig, dateBehaviorOf, FieldMap, GanttLayout, hasHierarchy, isDateOnlyColumn, isProjectTaskTable, mapRecord, normalizeId, resolveFieldMap, toParentRef } from "./src/fieldMap";
import { browserOffset, DateBehavior, DeadlineThresholds, lastOverdueDay, resolveThresholds, userCalendarDay } from "./src/deadline";
import { buildHierarchy, Hierarchy } from "./src/hierarchy";
import { customLinkSource, LinkSource, PROJECT_OPERATIONS_LINKS } from "./src/dependencies";
import { DependencyLoader, DependencyView, ScopedTask, WebApiLike } from "./src/dependencyLoader";
import { ColumnAccess, metadataClientUrl, webApiReader } from "./src/columnAccess";
import { AppliedFilter, buildFilterExpression, ChoiceOption, choiceOptionsFromMetadata, cloneFilter, criteriaConditions, criteriaKey, currentHostFilter, EMPTY_CRITERIA, FilterColumn, filterKind, GanttCriteria, matchingTotal, MatchingTotal, normalizeCriteria, SearchState } from "./src/viewCriteria";

type ConditionExpression = ComponentFramework.PropertyHelper.DataSetApi.ConditionExpression;
type FilterExpression = ComponentFramework.PropertyHelper.DataSetApi.FilterExpression;
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

const PROJECT_ENTITY = "msdyn_project";
const NO_PROJECT_COLUMN = "Dependency lines need each task's project. Add the Project column to this view, or open the Gantt on a project form.";
const NO_PROJECT_VALUES = "None of the loaded tasks has a Project value, so their dependency links cannot be read. Check the Project column in this view.";
const HOST_FILTER_CHANGED = "The view's filters were changed outside the Gantt, so the Gantt's search and filters were cleared. The view's filters are unchanged.";
const HOST_FILTER_UNAVAILABLE = "Search and filters were not applied: the host did not return its current filter, so it could not be preserved.";
const LOGICAL_NAME = /^[a-z_][a-z0-9_]*$/;
// ConditionOperator values supported by the PCF typings: NotEqual, GreaterEqual, In, OnOrBefore.
const CONDITION_NOT_EQUAL = 1;
const CONDITION_GREATER_EQUAL = 4;
const CONDITION_IN = 8;
const CONDITION_ON_OR_BEFORE = 26;
// AttributeMetadata DateTimeBehavior: numeric in model-driven host metadata, named in Web API-shaped metadata.
const DATE_BEHAVIORS: Record<string, DateBehavior> = { "1": "userLocal", "2": "dateOnly", "3": "timeZoneIndependent", UserLocal: "userLocal", DateOnly: "dateOnly", TimeZoneIndependent: "timeZoneIndependent" };
const DEFAULT_FILTER_SIGNATURE = "status:all:|createdOn:all|dueDate:all";
const FLAT_PAGE_SIZE = 10;
const HIERARCHY_PAGE_SIZE = 50;
const LICENSE_CACHE_PREFIX = "modernGanttLicense";
const LICENSE_CACHE_SCHEMA_VERSION = 1;
const DATAVERSE_CACHE_VERSION = 1;
const SUPPORT_EMAIL = "support@simetrixconsult.com";

export class TaskGantt implements ComponentFramework.ReactControl<IInputs, IOutputs> {
  private context!: ComponentFramework.Context<IInputs>;
  private notifyOutputChanged?: () => void;
  private configuredPageSize = 0;
  private lastCycleWarningSignature = "";
  private dependencyLoader?: DependencyLoader;
  private filters: FilterState = { status: "all", createdOn: "all", dueDate: "all" };
  private sorting: SortState;
  private lastAppliedFilterSignature = DEFAULT_FILTER_SIGNATURE;
  // Search and column filters; with the toolbar filters they are the Gantt's own conditions inside the dataset filter.
  private criteria: GanttCriteria = EMPTY_CRITERIA;
  private appliedFilter?: AppliedFilter;
  private criteriaNotice = "";
  private columnAccess?: ColumnAccess;
  private columnAccessKey = "";
  private choiceOptions = new Map<string, ChoiceOption[] | "pending" | { error: string }>();
  private searchMetadata = new Map<string, SearchState | "pending">();
  // Dataverse date behavior of each mapped Date and Time column; user local until metadata says otherwise.
  private dateBehaviors = new Map<string, DateBehavior | "pending">();
  private lastRecordCount?: { loaded: number; total: MatchingTotal };
  private lastAppliedSortingSignature = "";
  private manualRefreshInFlight = false;
  private manualRefreshSawLoading = false;
  private instanceId = `taskgantt-${Math.random().toString(36).slice(2)}`;
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
  // Set by destroy: late async results (license, metadata, links, permissions) must not render a destroyed control.
  private destroyed = false;

  private static readonly BUILD_VERSION = "3.7.1";
  private static readonly CONTROL_CODE = "moderngantt";
  private static readonly LICENSE_ENDPOINT = "https://modern365timeline-license-fkh6gbgdhnchgyhj.westeurope-01.azurewebsites.net/api/validateLicense";

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void
  ): void {
    this.context = context;
    this.notifyOutputChanged = notifyOutputChanged;
    context.mode.trackContainerResize(true);
    this.dependencyLoader = new DependencyLoader(context.webAPI as unknown as WebApiLike, () => this.requestControlRender());
  }

  public updateView(context: ComponentFramework.Context<IInputs>): React.ReactElement {
    this.context = context;
    this.ensureLicenseValidation(context);

    const ds = context.parameters.tasks;
    const fieldMap = this.getFieldMap(ds);
    const hierarchyEnabled = hasHierarchy(fieldMap);
    const pageSize = hierarchyEnabled ? HIERARCHY_PAGE_SIZE : FLAT_PAGE_SIZE;
    if (this.configuredPageSize !== pageSize) {
      ds.paging.setPageSize(pageSize);
      this.configuredPageSize = pageSize;
    }

    if (this.manualRefreshInFlight) {
      if (ds.loading) {
        this.manualRefreshSawLoading = true;
      } else if (this.manualRefreshSawLoading) {
        this.manualRefreshInFlight = false;
        this.manualRefreshSawLoading = false;
      }
    }

    // One "today" and one date conversion, in the user's Dynamics time zone, for bars, colours, icons and filters.
    const offsetFor = this.getOffsetReader(context);
    const today = userCalendarDay(new Date(), offsetFor(new Date()));
    const table = ds.getTargetEntityType?.() ?? "";
    const behaviorOf = (column: ColumnLike) => this.getDateBehavior(context, table, column);
    const mappedTasks: TaskItem[] = ds.sortedRecordIds.map((id: string) => mapRecord(id, ds.records[id], fieldMap, { behaviorOf, offsetFor }));
    const tasks: TaskItem[] = sortTasksForDisplay(mappedTasks, this.sorting);
    this.logSortDiagnostics(mappedTasks, tasks);

    let layout: GanttLayout = buildLayout(fieldMap);
    const deadline = this.getThresholds(context);
    const statusValueNotice = this.checkStatusValues(context, ds, fieldMap);
    const notices = [layout.notice, deadline.error, statusValueNotice].filter(Boolean);
    if (notices.length) layout = { ...layout, notice: notices.join(" ") };
    let hierarchy: Hierarchy | undefined;
    if (hierarchyEnabled) {
      // A user sort orders siblings; otherwise the mapped sequence does, falling back to the server order.
      hierarchy = buildHierarchy(tasks, { entityType: ds.getTargetEntityType?.(), useSequence: !this.sorting && Boolean(fieldMap.columns.sequence) });
      if (hierarchy.mismatchedTarget) {
        layout = { ...layout, notice: `The Parent column points to the ${hierarchy.mismatchedTarget} table, so rows are shown without a hierarchy. Map a lookup to this table.` };
        hierarchy = undefined;
      } else {
        this.warnBrokenCycles(hierarchy.brokenCycleIds);
      }
    }

    const allocatedWidth = Number(context.mode.allocatedWidth) || 0;
    const allocatedHeight = Number(context.mode.allocatedHeight) || 0;

    const dependencies = this.getDependencies(context, ds);

    if (!ds.loading) this.reconcileHostFilter(ds);
    if (this.licenseState === "licensed") this.ensureColumnAccess(context, ds);
    const filterColumns = this.getFilterColumns(context, ds);
    const search = this.getSearchState(context, ds);
    if (this.columnAccess?.failed && !this.criteriaNotice) this.criteriaNotice = "Column filters are unavailable: column permissions could not be verified.";
    const filteredFields = this.getFilteredFields(fieldMap);

    // Counts only dataset records. The total is Dataverse's own count for the current view, search and filters;
    // while a request is running the last count stays visible and is marked as updating.
    if (!ds.loading) {
      const loaded = ds.sortedRecordIds.length;
      this.lastRecordCount = { loaded, total: matchingTotal(ds.paging.totalResultCount, loaded, ds.paging.hasNextPage) };
    }
    const recordCount = this.lastRecordCount ? { ...this.lastRecordCount, updating: ds.loading } : undefined;

    return React.createElement(Gantt, {
      tasks,
      today,
      thresholds: deadline.thresholds,
      hierarchy,
      dependencies,
      pageSize,
      layout,
      allocatedHeight,
      allocatedWidth,
      loading: ds.loading,
      filters: this.filters,
      criteria: this.criteria,
      filterColumns,
      search,
      filteredFields,
      criteriaNotice: this.criteriaNotice,
      recordCount,
      onCriteriaChange: (criteria: GanttCriteria) => this.applyServerFilter(ds, this.filters, criteria),
      onClearAll: () => this.applyServerFilter(ds, { status: "all", createdOn: "all", dueDate: "all" }, EMPTY_CRITERIA),
      sorting: this.sorting,
      licenseState: this.licenseState,
      licenseMessage: this.licenseMessage,
      licenseDebugInfo: this.licenseDebugInfo,
      onRevalidateLicense: () => this.revalidateLicense(),
      onFiltersChange: (filters: FilterState) => this.applyFilters(ds, filters),
      onSortChange: (sorting: SortState) => this.applySorting(ds, sorting),
      onRefresh: () => this.refreshDataset(ds),
      onOpen: (recordId: string) => ds.openDatasetItem(ds.records[recordId].getNamedReference()),
      onLoadMore: ds.paging.hasNextPage && !ds.loading ? () => ds.paging.loadNextPage() : undefined,
      refreshDisabled: ds.loading || this.manualRefreshInFlight,
      refreshing: ds.loading || this.manualRefreshInFlight,
      instanceId: this.instanceId
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

  private getFieldMap(ds: ComponentFramework.PropertyTypes.DataSet): FieldMap {
    return resolveFieldMap(ds.columns, ds.getTargetEntityType?.(), this.getCompletionConfig());
  }

  private parameter(name: string): unknown {
    const parameters = this.context?.parameters as unknown as Record<string, { raw?: unknown } | undefined> | undefined;
    return parameters?.[name]?.raw;
  }

  // Explicit completion semantics (raw values only). Empty settings keep the built-in Task statecode or Neutral rows.
  private getCompletionConfig(): CompletionConfig {
    const text = (name: string) => { const raw = this.parameter(name); return typeof raw === "string" ? raw : null; };
    const progress = this.parameter("progressCompleteValue");
    return {
      completedValues: text("completedStatusValues"),
      canceledValues: text("canceledStatusValues"),
      progressColumn: text("progressColumn"),
      progressCompleteValue: typeof progress === "number" ? progress : null
    };
  }

  private getThresholds(context: ComponentFramework.Context<IInputs>): { thresholds: DeadlineThresholds; error?: string } {
    const parameters = context.parameters as unknown as Record<string, { raw?: unknown } | undefined>;
    return resolveThresholds({ approaching: parameters.dueSoonDays?.raw, near: parameters.dueNearDays?.raw, imminent: parameters.dueImminentDays?.raw });
  }

  // The Dynamics user's time zone offset (minutes east of UTC) for an instant; the browser's only when the host has none.
  private getOffsetReader(context: ComponentFramework.Context<IInputs>): (instant: Date) => number {
    const settings = context.userSettings as unknown as { getTimeZoneOffsetMinutes?: (date?: Date) => number } | undefined;
    if (typeof settings?.getTimeZoneOffsetMinutes !== "function") return browserOffset;
    return (instant: Date) => {
      try {
        const offset = settings.getTimeZoneOffsetMinutes?.(instant);
        return typeof offset === "number" && Number.isFinite(offset) ? offset : browserOffset(instant);
      } catch {
        return browserOffset(instant);
      }
    };
  }

  // Date Only columns are known from the dataset; Date and Time columns are user local unless metadata says time zone
  // independent. Metadata is read once per column.
  private getDateBehavior(context: ComponentFramework.Context<IInputs>, table: string, column: ColumnLike): DateBehavior {
    if (isDateOnlyColumn(column) || !table || !LOGICAL_NAME.test(column.name)) return dateBehaviorOf(column);
    const key = `${table}|${column.name}`;
    const cached = this.dateBehaviors.get(key);
    if (cached && cached !== "pending") return cached;
    if (!cached && typeof context.utils?.getEntityMetadata === "function") {
      this.dateBehaviors.set(key, "pending");
      void this.loadDateBehavior(context, table, column.name, key);
    }
    return "userLocal";
  }

  private async loadDateBehavior(context: ComponentFramework.Context<IInputs>, table: string, name: string, key: string): Promise<void> {
    let behavior: DateBehavior = "userLocal";
    try {
      const metadata = await context.utils.getEntityMetadata(table, [name]) as { Attributes?: { get?: (name: string) => Record<string, unknown> | undefined } };
      const attribute = metadata?.Attributes?.get?.(name);
      const raw = attribute?.Behavior ?? (attribute?.DateTimeBehavior as { Value?: unknown } | undefined)?.Value ?? attribute?.DateTimeBehavior;
      behavior = DATE_BEHAVIORS[String(raw)] ?? "userLocal";
    } catch (error) {
      console.error(`TaskGantt could not read the date behavior of ${name}; it is treated as user local.`, error);
    }
    this.dateBehaviors.set(key, behavior);
    if (behavior !== "userLocal") this.requestControlRender();
  }

  // Configured status values must be options of the Status column; a mistyped value would silently never match.
  private checkStatusValues(context: ComponentFramework.Context<IInputs>, ds: ComponentFramework.PropertyTypes.DataSet, fieldMap: FieldMap): string | undefined {
    const completion = fieldMap.completion;
    if (completion?.kind !== "status" || completion.source !== "configured" || completion.column.name.includes(".")) return undefined;
    const options = this.getChoiceOptions(context, ds, completion.column.name);
    if (!Array.isArray(options)) return undefined;
    const unknown = [...completion.completed, ...completion.canceled].filter(value => !options.some(option => option.value === value));
    return unknown.length ? `${unknown.join(", ")} ${unknown.length === 1 ? "is not an option" : "are not options"} of ${completion.column.displayName || completion.column.name}; check the Completed and Canceled status values.` : undefined;
  }

  // Dependency lines: explicit custom link-table settings win; Project Operations tasks use the verified defaults.
  // Returns undefined when no link source applies, so existing configurations render exactly as before.
  private getDependencies(context: ComponentFramework.Context<IInputs>, ds: ComponentFramework.PropertyTypes.DataSet): DependencyView | undefined {
    const parameters = context.parameters as unknown as Record<string, { raw?: unknown } | undefined>;
    const text = (name: string) => (typeof parameters[name]?.raw === "string" ? parameters[name]?.raw as string : "");
    if (text("dependencyMode").trim().toLowerCase() === "off") return undefined;

    const custom = customLinkSource({ table: text("dependencyTable"), predecessorColumn: text("dependencyPredecessorColumn"), successorColumn: text("dependencySuccessorColumn") });
    if (custom.error) return { status: "error", links: [], skipped: [], message: custom.error, errorKind: "config" };
    const source: LinkSource | undefined = custom.source ?? (isProjectTaskTable(ds.getTargetEntityType?.()) ? PROJECT_OPERATIONS_LINKS : undefined);
    if (!source || !this.dependencyLoader) return undefined;
    if (!ds.sortedRecordIds.length) return { status: "ready", links: [], skipped: [] };

    let tasks: ScopedTask[] = ds.sortedRecordIds.map((id: string) => ({ id }));
    let unscoped = 0;
    if (source.kind === "projectOperations") {
      const scoped = this.getProjectScopes(context, ds);
      if ("error" in scoped) return { status: "error", links: [], skipped: [], message: scoped.error, errorKind: "noProject" };
      tasks = scoped.tasks;
      unscoped = scoped.unscoped;
    }
    this.dependencyLoader.sync(source, tasks);
    const view = this.dependencyLoader.view();
    return unscoped ? { ...view, unscoped } : view;
  }

  // Each loaded task's project: the hosting project form scopes every row; otherwise each row's own Project lookup
  // does, so a multi-project view reads every represented project. Rows without a Project value are not read.
  private getProjectScopes(context: ComponentFramework.Context<IInputs>, ds: ComponentFramework.PropertyTypes.DataSet): { tasks: ScopedTask[]; unscoped: number } | { error: string } {
    const info = (context.mode as unknown as { contextInfo?: { entityTypeName?: string; entityId?: string } }).contextInfo;
    if (info?.entityTypeName?.toLowerCase() === PROJECT_ENTITY && info.entityId) {
      const scope = normalizeId(info.entityId);
      return { tasks: ds.sortedRecordIds.map((id: string) => ({ id, scope })), unscoped: 0 };
    }
    if (!ds.columns.some(column => column.name === PROJECT_ENTITY)) return { error: NO_PROJECT_COLUMN };
    const tasks: ScopedTask[] = [];
    ds.sortedRecordIds.forEach((id: string) => {
      const scope = toParentRef(ds.records[id].getValue(PROJECT_ENTITY), "")?.id;
      if (scope) tasks.push({ id, scope });
    });
    if (!tasks.length) return { error: NO_PROJECT_VALUES };
    return { tasks, unscoped: ds.sortedRecordIds.length - tasks.length };
  }

  private warnBrokenCycles(recordIds: string[]): void {
    const signature = recordIds.join("|");
    if (signature === this.lastCycleWarningSignature) return;
    this.lastCycleWarningSignature = signature;
    if (recordIds.length) {
      console.warn(`TaskGantt found ${recordIds.length} row(s) whose parent forms a loop or points to itself. They are shown at the top level.`, recordIds);
    }
  }

  private applyFilters(ds: ComponentFramework.PropertyTypes.DataSet, filters: FilterState): void {
    this.applyServerFilter(ds, filters, this.criteria);
  }

  // Toolbar filters, search and column filters become one set of the Gantt's own conditions, ANDed with the host's
  // current filter (re-derived on every change), then the dataset is queried again from page 1.
  private applyServerFilter(ds: ComponentFramework.PropertyTypes.DataSet, filters: FilterState, criteria: GanttCriteria): void {
    const fieldMap = this.getFieldMap(ds);
    const nextCriteria = normalizeCriteria(criteria);
    const today = this.getToday();
    const signature = `${this.getFilterSignature(filters, fieldMap, today)}|${criteriaKey(nextCriteria)}`;
    if (signature === this.lastAppliedFilterSignature) return;

    // A host that cannot report its filter keeps the 3.5.0 behaviour for the toolbar filters; search and column
    // filters are never offered there.
    let derived: ReturnType<typeof currentHostFilter> = { host: null };
    if (typeof ds.filtering.getFilter === "function") {
      let current: FilterExpression | null;
      try {
        current = cloneFilter(ds.filtering.getFilter());
      } catch (error) {
        console.error("TaskGantt could not read the host filter.", error);
        this.criteriaNotice = HOST_FILTER_UNAVAILABLE;
        this.requestControlRender();
        return;
      }
      derived = currentHostFilter(current, this.appliedFilter);
    }
    if (derived === "lost") {
      this.resetCriteriaForHostChange();
      return;
    }

    const own = [
      ...this.buildFilterConditions(fieldMap, filters, today),
      ...criteriaConditions(nextCriteria, this.getSearchColumnName())
    ];
    const expression = buildFilterExpression(own, derived.host);

    this.filters = filters;
    this.criteria = nextCriteria;
    this.lastAppliedFilterSignature = signature;
    // Without own conditions the dataset holds only the host's filter, so nothing is owned.
    this.appliedFilter = expression && own.length ? { expression, host: derived.host, own } : undefined;
    this.criteriaNotice = "";

    if (!expression) {
      ds.filtering.clearFilter();
    } else {
      ds.filtering.setFilter(expression);
    }

    // Refresh returns the dataset to page 1.
    ds.paging.reset();
    ds.refresh();
  }

  // Dynamics replaced or rewrote the Gantt's conditions. Its filter is authoritative and is never overwritten from a guess.
  private resetCriteriaForHostChange(): void {
    this.filters = { status: "all", createdOn: "all", dueDate: "all" };
    this.criteria = EMPTY_CRITERIA;
    this.appliedFilter = undefined;
    this.lastAppliedFilterSignature = DEFAULT_FILTER_SIGNATURE;
    this.criteriaNotice = HOST_FILTER_CHANGED;
    this.requestControlRender();
  }

  // After host updates, follow host-side filter changes so a later Gantt change keeps them.
  private reconcileHostFilter(ds: ComponentFramework.PropertyTypes.DataSet): void {
    if (!this.appliedFilter || typeof ds.filtering?.getFilter !== "function") return;
    let current: FilterExpression | null;
    try { current = cloneFilter(ds.filtering.getFilter()); } catch { return; }
    const derived = currentHostFilter(current, this.appliedFilter);
    if (derived === "lost") { this.resetCriteriaForHostChange(); return; }
    if (current) this.appliedFilter = { ...this.appliedFilter, expression: current, host: derived.host };
  }

  private filteringSupported(ds: ComponentFramework.PropertyTypes.DataSet): boolean {
    const filtering = ds.filtering as Partial<ComponentFramework.PropertyHelper.DataSetApi.Filtering> | undefined;
    return typeof filtering?.getFilter === "function" && typeof filtering.setFilter === "function" && typeof filtering.clearFilter === "function";
  }

  private ensureColumnAccess(context: ComponentFramework.Context<IInputs>, ds: ComponentFramework.PropertyTypes.DataSet): void {
    const table = (ds.getTargetEntityType?.() ?? "").toLowerCase();
    const clientUrl = metadataClientUrl(context);
    const userId = (context as unknown as { userSettings?: { userId?: string } }).userSettings?.userId ?? "";
    const key = `${clientUrl ?? ""}|${table}|${userId}`;
    if (!clientUrl || !table || !userId || key === this.columnAccessKey) return;
    this.columnAccessKey = key;
    try {
      const access = new ColumnAccess(table, userId, webApiReader(clientUrl), () => { if (this.columnAccess === access) this.requestControlRender(); });
      this.columnAccess = access;
      void access.load();
    } catch (error) {
      console.error("TaskGantt could not check column permissions.", error);
      this.columnAccess = undefined;
    }
  }

  // Columns are offered only when filtering is supported, the column is on the table itself (not a linked table) and
  // the user may filter by it. Choice options come from metadata, so values are raw and labels are localized.
  private getFilterColumns(context: ComponentFramework.Context<IInputs>, ds: ComponentFramework.PropertyTypes.DataSet): FilterColumn[] {
    if (!this.filteringSupported(ds) || !this.columnAccess) return [];
    const seen = new Set<string>();
    const result: FilterColumn[] = [];
    ds.columns.forEach(column => {
      const name = column.name;
      const kind = filterKind(column.dataType);
      if (!kind || !name || name.includes(".") || seen.has(name) || this.columnAccess?.canFilter(name) !== "allowed") return;
      seen.add(name);
      const entry: FilterColumn = { name, label: column.displayName || name, kind };
      if (kind === "choice") {
        const options = this.getChoiceOptions(context, ds, name);
        if (Array.isArray(options)) entry.options = options;
        else if (options && options !== "pending") entry.optionsError = options.error;
      }
      result.push(entry);
    });
    return result;
  }

  private getChoiceOptions(context: ComponentFramework.Context<IInputs>, ds: ComponentFramework.PropertyTypes.DataSet, attribute: string): ChoiceOption[] | "pending" | { error: string } {
    const table = ds.getTargetEntityType?.() ?? "";
    const key = `${table}|${attribute}`;
    const cached = this.choiceOptions.get(key);
    if (cached) return cached;
    this.choiceOptions.set(key, "pending");
    void this.loadChoiceOptions(context, table, attribute, key);
    return "pending";
  }

  private async loadChoiceOptions(context: ComponentFramework.Context<IInputs>, table: string, attribute: string, key: string): Promise<void> {
    try {
      const metadata = await context.utils.getEntityMetadata(table, [attribute]) as { Attributes?: { get?: (name: string) => unknown } };
      const attributeMetadata = metadata?.Attributes?.get?.(attribute) as { OptionSet?: unknown; _optionSet?: unknown } | undefined;
      const set = attributeMetadata?.OptionSet ?? attributeMetadata?._optionSet;
      if (!set) throw new Error("No OptionSet metadata.");
      const options = choiceOptionsFromMetadata(set);
      if (!options.length) throw new Error("No options returned.");
      this.choiceOptions.set(key, options);
    } catch (error) {
      console.error(`TaskGantt could not load the choices for ${attribute}.`, error);
      this.choiceOptions.set(key, { error: "The choices for this column could not be loaded. Refresh the page to retry." });
    }
    this.requestControlRender();
  }

  private getSearchColumnName(): string | undefined {
    const parameters = this.context?.parameters as unknown as Record<string, { raw?: unknown } | undefined> | undefined;
    const raw = parameters?.searchColumn?.raw;
    const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    return name && LOGICAL_NAME.test(name) ? name : undefined;
  }

  // The configured search column must be a text column the user may filter by. Returns undefined while it is checked.
  private getSearchState(context: ComponentFramework.Context<IInputs>, ds: ComponentFramework.PropertyTypes.DataSet): SearchState | undefined {
    const parameters = context.parameters as unknown as Record<string, { raw?: unknown } | undefined>;
    const raw = typeof parameters.searchColumn?.raw === "string" ? (parameters.searchColumn.raw as string).trim().toLowerCase() : "";
    if (!raw) return undefined;
    if (!LOGICAL_NAME.test(raw)) return { error: `Search is unavailable: “${raw}” is not a column logical name.` };
    if (!this.filteringSupported(ds)) return { error: "Search is unavailable: this host does not let the Gantt filter its records." };
    const column = ds.columns.find(candidate => candidate.name.toLowerCase() === raw);
    let state: SearchState;
    if (column) {
      state = filterKind(column.dataType) === "text" ? { label: column.displayName || raw } : { error: `Search is unavailable: ${column.displayName || raw} is not a text column.` };
    } else {
      const table = ds.getTargetEntityType?.() ?? "";
      const key = `${table}|${raw}`;
      const cached = this.searchMetadata.get(key);
      if (!cached) { this.searchMetadata.set(key, "pending"); void this.loadSearchMetadata(context, key, table, raw); }
      if (!cached || cached === "pending") return undefined;
      state = cached;
    }
    if (state.error) return state;
    if (!this.columnAccess || this.columnAccess.failed) return { error: "Search is unavailable: column permissions could not be verified." };
    const access = this.columnAccess.canFilter(raw);
    if (access === "denied") return { error: `Search is unavailable: you cannot filter by ${state.label}.` };
    return access === "allowed" ? state : undefined;
  }

  private async loadSearchMetadata(context: ComponentFramework.Context<IInputs>, key: string, table: string, name: string): Promise<void> {
    let state: SearchState;
    try {
      const metadata = await context.utils.getEntityMetadata(table, [name]) as { Attributes?: { get?: (name: string) => Record<string, unknown> | undefined } };
      const attribute = metadata?.Attributes?.get?.(name);
      const type = attribute?.AttributeType ?? (attribute?.AttributeTypeName as { Value?: string } | undefined)?.Value;
      const label = typeof attribute?.DisplayName === "string" && attribute.DisplayName ? attribute.DisplayName : name;
      state = !attribute ? { error: `Search is unavailable: column “${name}” was not found on this table.` }
        : [14, 7, "String", "Memo", "StringType", "MemoType"].includes(type as string | number) ? { label }
        : { error: `Search is unavailable: ${label} is not a text column.` };
    } catch (error) {
      console.error("TaskGantt could not verify the search column.", error);
      state = { error: "Search is unavailable: the search column could not be verified." };
    }
    this.searchMetadata.set(key, state);
    this.requestControlRender();
  }

  // Mapped Gantt columns that currently have a column filter (or the search), for the header indicators.
  private getFilteredFields(fieldMap: FieldMap): string[] {
    const filtered = new Set(this.criteria.filters.map(filter => filter.column));
    const search = this.criteria.search ? this.getSearchColumnName() : undefined;
    if (search) filtered.add(search);
    return (Object.keys(fieldMap.columns) as Array<keyof FieldMap["columns"]>)
      .filter(key => { const name = fieldMap.columns[key]?.name; return Boolean(name && filtered.has(name)); });
  }

  private getToday(): Date {
    const offsetFor = this.context ? this.getOffsetReader(this.context) : browserOffset;
    const now = new Date();
    return userCalendarDay(now, offsetFor(now));
  }

  // The completion filter uses only known raw values, with the same rules as the row colours: Completed is a completed
  // value, Active any other value (not Canceled), and Overdue is Active with Finish on or before yesterday in the user's
  // time zone, which Dataverse evaluates with the column's own date behavior. A task due today is never overdue.
  private buildFilterConditions(fieldMap: FieldMap, filters: FilterState, today: Date): ConditionExpression[] {
    const conditions: ConditionExpression[] = [];
    const completion = fieldMap.completion;
    const createdOnColumn = fieldMap.columns.createdOn;
    const dueDateColumn = fieldMap.columns.finish;

    if (filters.status !== "all" && !completion) {
      console.warn(`TaskGantt has no completion semantics for this mapping. The ${filters.status} status filter was skipped.`);
    } else if (filters.status !== "all" && completion) {
      const attributeName = completion.column.name;
      if (completion.kind === "progress") {
        conditions.push({ attributeName, conditionOperator: filters.status === "completed" ? CONDITION_GREATER_EQUAL : 3, value: String(completion.completeAt) });
      } else if (filters.status === "completed") {
        conditions.push(completion.completed.length === 1
          ? { attributeName, conditionOperator: 0, value: completion.completed[0] }
          : { attributeName, conditionOperator: CONDITION_IN, value: completion.completed });
      } else if (completion.open) {
        conditions.push(completion.open.length === 1
          ? { attributeName, conditionOperator: 0, value: completion.open[0] }
          : { attributeName, conditionOperator: CONDITION_IN, value: completion.open });
      } else {
        // Not in (completed, canceled), written as not-equal conditions because the PCF filter API has no NotIn.
        [...completion.completed, ...completion.canceled].forEach(value => conditions.push({ attributeName, conditionOperator: CONDITION_NOT_EQUAL, value }));
      }
      if (filters.status === "overdue") {
        if (!dueDateColumn) {
          console.warn("TaskGantt could not resolve the mapped Finish dataset column. Overdue condition was skipped.");
        } else {
          conditions.push({ attributeName: dueDateColumn.name, conditionOperator: CONDITION_ON_OR_BEFORE, value: lastOverdueDay(today) });
        }
      }
    }

    this.addDateCondition(conditions, createdOnColumn, filters.createdOn);
    this.addDateCondition(conditions, dueDateColumn, filters.dueDate);
    return conditions;
  }

  private addDateCondition(conditions: ConditionExpression[], column: ColumnLike | undefined, filter: DateFilter): void {
    if (filter === "all" || !column) return;
    conditions.push({
      attributeName: column.name,
      conditionOperator: DATE_FILTER_OPERATORS[filter],
      value: ""
    });
  }

  // Overdue depends on the user's current day, so it is part of the signature.
  private getFilterSignature(filters: FilterState, fieldMap: FieldMap, today: Date): string {
    const completion = fieldMap.completion;
    const completionSignature = filters.status === "all" || !completion ? ""
      : completion.kind === "progress" ? `${completion.column.name}>=${completion.completeAt}` : `${completion.column.name}:${completion.completed.join(",")}/${completion.canceled.join(",")}`;
    const daySignature = filters.status === "overdue" ? `:${lastOverdueDay(today)}` : "";
    return `status:${filters.status}:${completionSignature}${daySignature}|createdOn:${filters.createdOn}|dueDate:${filters.dueDate}`;
  }

  private applySorting(ds: ComponentFramework.PropertyTypes.DataSet, sorting: SortState): void {
    const fieldMap = this.getFieldMap(ds);
    const columns: Record<NonNullable<SortState>["key"], ColumnLike | undefined> = {
      task: fieldMap.columns.title,
      assignedTo: fieldMap.columns.owner,
      startDate: fieldMap.columns.start,
      dueDate: fieldMap.columns.finish
    };
    const column = sorting ? columns[sorting.key] : undefined;

    if (sorting && !column) {
      console.warn(`TaskGantt could not resolve the mapped column for ${sorting.key}. Sorting was skipped.`);
      return;
    }

    const columnName = sorting && column ? column.name : "";
    const signature = sorting && column ? `${columnName}:${sorting.direction}` : "";
    if (signature === this.lastAppliedSortingSignature) return;

    this.sorting = sorting;
    this.lastAppliedSortingSignature = signature;
    this.logSortRequest(sorting, columnName);
    ds.sorting = sorting && column ? [{
      name: columnName,
      sortDirection: sorting.direction === "asc" ? 0 : 1
    } as SortStatus] : [];
    ds.paging.reset();
    ds.refresh();
  }

  private logSortRequest(sorting: SortState, resolvedColumnName: string): void {
    if (!sorting || !shouldLogSortDiagnostics()) return;
    console.info("TaskGantt sort requested", {
      clickedColumn: sorting.key,
      requestedDirection: sorting.direction,
      resolvedColumnName
    });
  }

  private logSortDiagnostics(before: TaskItem[], after: TaskItem[]): void {
    if (!this.sorting || !shouldLogSortDiagnostics()) return;
    console.info("TaskGantt sort diagnostics", {
      sortColumn: this.sorting.key,
      direction: this.sorting.direction,
      before: before.map(task => this.getRedactedSortDiagnosticValue(task)),
      after: after.map(task => this.getRedactedSortDiagnosticValue(task)),
      rendererRecordIds: after.map(task => task.recordId)
    });
  }

  private getRedactedSortDiagnosticValue(task: TaskItem): { recordId: string; value: string | number | null } {
    if (!this.sorting) return { recordId: task.recordId, value: null };
    if (this.sorting.key === "startDate" || this.sorting.key === "dueDate") {
      const date = this.sorting.key === "startDate" ? task.start : task.due;
      const value = date ? date.getTime() : Number.NaN;
      return { recordId: task.recordId, value: Number.isNaN(value) ? null : value };
    }

    const text = this.sorting.key === "task" ? task.name : task.assignedTo;
    const normalized = text.trim().toLocaleLowerCase();
    return { recordId: task.recordId, value: normalized ? `hash:${hashString(normalized)}` : null };
  }

  private refreshDataset(ds: ComponentFramework.PropertyTypes.DataSet): void {
    if (ds.loading || this.manualRefreshInFlight) return;
    this.manualRefreshInFlight = true;
    this.manualRefreshSawLoading = false;
    // Links may have changed too; drop the cache so the refreshed rows are read again.
    this.dependencyLoader?.reset();
    this.requestControlRender();
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
    if (this.destroyed) return;
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
    if (this.destroyed) return;

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
    this.destroyed = true;
    this.clearLicenseWatchdog();
    this.activeLicenseAbortController?.abort();
    this.dependencyLoader?.reset();
    cleanupTaskGanttOverlays(this.instanceId);
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

function shouldLogSortDiagnostics(): boolean {
  try {
    return typeof process !== "undefined"
      && process.env
      && process.env.NODE_ENV !== "production"
      && typeof window !== "undefined"
      && window.localStorage?.getItem("TaskGanttSortDiagnostics") === "true";
  } catch {
    return false;
  }
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
