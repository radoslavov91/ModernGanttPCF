import { IInputs, IOutputs } from "./generated/ManifestTypes";
import * as React from "react";
import { DateFilter, Gantt, isTaskOverdue, StatusFilter, TaskItem } from "./src/Gantt";

type Column = ComponentFramework.PropertyHelper.DataSetApi.Column;
type ConditionExpression = ComponentFramework.PropertyHelper.DataSetApi.ConditionExpression;
type ConditionOperator = ComponentFramework.PropertyHelper.DataSetApi.Types.ConditionOperator;

type FilterState = {
  status: StatusFilter;
  createdOn: DateFilter;
  dueDate: DateFilter;
};

const DATE_FILTER_OPERATORS: Record<Exclude<DateFilter, "all">, ConditionOperator> = {
  lastWeek: 19,
  thisWeek: 20,
  lastMonth: 22,
  thisMonth: 23
};

export class TaskGantt implements ComponentFramework.ReactControl<IInputs, IOutputs> {
  private pageSizeConfigured = false;
  private filters: FilterState = { status: "all", createdOn: "all", dueDate: "all" };
  private lastAppliedFilterSignature = "status:all:|createdOn:all|dueDate:all";
  private completedRawValue: string | undefined;
  private observedActiveRawValue: string | undefined;
  private lastStatusResolutionLogSignature = "";

  public init(context: ComponentFramework.Context<IInputs>): void {
    context.mode.trackContainerResize(true);
  }

  public updateView(context: ComponentFramework.Context<IInputs>): React.ReactElement {
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
      onFiltersChange: (filters: FilterState) => this.applyFilters(ds, filters),
      onOpen: (recordId: string) => ds.openDatasetItem(ds.records[recordId].getNamedReference()),
      onLoadMore: ds.paging.hasNextPage && !ds.loading ? () => ds.paging.loadNextPage() : undefined
    });
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
            void isTaskOverdue;
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

  public getOutputs(): IOutputs { return {}; }
  public destroy(): void { /* React lifecycle is managed by the PCF framework. */ }
}
