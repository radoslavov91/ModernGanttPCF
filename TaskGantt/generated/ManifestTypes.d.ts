/*
*This is auto generated from the ControlManifest.Input.xml file
*/

// Define IInputs and IOutputs Type. They should match with ControlManifest.
export interface IInputs {
    licenseKey: ComponentFramework.PropertyTypes.StringProperty;
    dependencyMode: ComponentFramework.PropertyTypes.EnumProperty<"auto" | "off">;
    dependencyTable: ComponentFramework.PropertyTypes.StringProperty;
    dependencyPredecessorColumn: ComponentFramework.PropertyTypes.StringProperty;
    dependencySuccessorColumn: ComponentFramework.PropertyTypes.StringProperty;
    searchColumn: ComponentFramework.PropertyTypes.StringProperty;
    completedStatusValues: ComponentFramework.PropertyTypes.StringProperty;
    canceledStatusValues: ComponentFramework.PropertyTypes.StringProperty;
    progressColumn: ComponentFramework.PropertyTypes.StringProperty;
    progressCompleteValue: ComponentFramework.PropertyTypes.WholeNumberProperty;
    dueSoonDays: ComponentFramework.PropertyTypes.WholeNumberProperty;
    dueNearDays: ComponentFramework.PropertyTypes.WholeNumberProperty;
    dueImminentDays: ComponentFramework.PropertyTypes.WholeNumberProperty;
    tasks: ComponentFramework.PropertyTypes.DataSet;
}
export interface IOutputs {
}
