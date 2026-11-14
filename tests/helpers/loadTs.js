const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const cache = new Map();

function resolveSource(fromDir, request) {
  for (const extension of ["", ".ts", ".tsx"]) {
    const candidate = path.resolve(fromDir, request + extension);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Cannot resolve ${request} from ${fromDir}`);
}

// Transpiles a TypeScript source (and its relative imports) on the fly so tests run without a bundle.
function loadTs(filePath) {
  const resolved = path.resolve(filePath);
  if (cache.has(resolved)) return cache.get(resolved).exports;

  const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
    fileName: resolved,
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      esModuleInterop: true
    }
  }).outputText;

  const testModule = { exports: {} };
  cache.set(resolved, testModule);
  const localRequire = request => request.startsWith(".")
    ? loadTs(resolveSource(path.dirname(resolved), request))
    : require(request);
  new Function("require", "module", "exports", output)(localRequire, testModule, testModule.exports);
  return testModule.exports;
}

const sourceRoot = path.join(__dirname, "..", "..", "TaskGantt");

module.exports = {
  loadTs,
  loadSource: relativePath => loadTs(path.join(sourceRoot, relativePath))
};
