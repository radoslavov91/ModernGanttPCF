const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "TaskGantt", "src", "Gantt.tsx");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.React,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2019,
    esModuleInterop: true
  }
}).outputText;

const moduleExports = {};
const testModule = { exports: moduleExports };
const load = new Function("require", "module", "exports", compiled);
load(require, testModule, moduleExports);

const { sortTasksForDisplay } = testModule.exports;

function task(recordId, name, assignedTo, start, due) {
  return {
    recordId,
    name,
    assignedTo,
    status: "Active",
    start: start ? new Date(start) : new Date("invalid"),
    due: due ? new Date(due) : new Date("invalid")
  };
}

const tasks = [
  task("3", "bravo", "Zed", "2026-01-03", "2026-01-06"),
  task("1", "APPROVAL COMMUNICATION", "Alice", "2026-01-01", "2026-01-04"),
  task("2", "alpha", "Bob", "2026-01-02", "2026-01-05"),
  task("4", "", "", null, null)
];

assert.deepStrictEqual(sortTasksForDisplay(tasks, { key: "task", direction: "asc" }).map(t => t.recordId), ["2", "1", "3", "4"]);
assert.deepStrictEqual(sortTasksForDisplay(tasks, { key: "task", direction: "desc" }).map(t => t.recordId), ["3", "1", "2", "4"]);
assert.deepStrictEqual(sortTasksForDisplay(tasks, { key: "assignedTo", direction: "asc" }).map(t => t.recordId), ["1", "2", "3", "4"]);
assert.deepStrictEqual(sortTasksForDisplay(tasks, { key: "assignedTo", direction: "desc" }).map(t => t.recordId), ["3", "2", "1", "4"]);
assert.deepStrictEqual(sortTasksForDisplay(tasks, { key: "startDate", direction: "asc" }).map(t => t.recordId), ["1", "2", "3", "4"]);
assert.deepStrictEqual(sortTasksForDisplay(tasks, { key: "startDate", direction: "desc" }).map(t => t.recordId), ["3", "2", "1", "4"]);
assert.deepStrictEqual(sortTasksForDisplay(tasks, { key: "dueDate", direction: "asc" }).map(t => t.recordId), ["1", "2", "3", "4"]);
assert.deepStrictEqual(sortTasksForDisplay(tasks, { key: "dueDate", direction: "desc" }).map(t => t.recordId), ["3", "2", "1", "4"]);

const stable = [
  task("a", "same", "owner", "2026-01-01", "2026-01-01"),
  task("b", "same", "owner", "2026-01-01", "2026-01-01"),
  task("c", "same", "owner", "2026-01-01", "2026-01-01")
];
assert.deepStrictEqual(sortTasksForDisplay(stable, { key: "task", direction: "asc" }).map(t => t.recordId), ["a", "b", "c"]);

const page = sortTasksForDisplay(tasks, { key: "task", direction: "asc" }).slice(0, 2);
assert.deepStrictEqual(page.map(t => t.recordId), ["2", "1"]);

console.log("TaskGantt sorting tests passed.");
