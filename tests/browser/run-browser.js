// Real Edge, the real control, React 16 and CSS at 100% zoom (1366x768), against a simulated Dataverse host that
// holds the saved view, evaluates the control's PCF filter expressions like the server, pages cumulatively, reports
// totalResultCount and answers dependency FetchXML. No network. Run with `npm run test:browser`.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");
const ts = require("typescript");

const root = path.join(__dirname, "..", "..");
const browser = process.env.GANTT_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
assert.ok(fs.existsSync(browser), "Set GANTT_TEST_BROWSER to an installed Chromium browser");
const output = path.join(root, "out", "browser-tests");
fs.mkdirSync(output, { recursive: true });

const sources = ["index", "src/Gantt", "src/fieldMap", "src/hierarchy", "src/dependencies", "src/dependencyLoader", "src/columnAccess", "src/viewCriteria", "src/deadline"];
const modules = Object.fromEntries(sources.map(name => [name, ts.transpileModule(fs.readFileSync(path.join(root, "TaskGantt", `${name}.${name === "src/Gantt" ? "tsx" : "ts"}`), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText]));
const fixture = JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "po-dependencies.json"), "utf8"));
const script = text => text.replace(/<\/script/gi, "<\\/script");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body { background: #f7f8fa; margin: 0; font-family: "Segoe UI", sans-serif; } .host { width: 1300px; height: 640px; margin: 12px; } #result { display: none; }
${fs.readFileSync(path.join(root, "TaskGantt", "css", "TaskGantt.css"), "utf8")}
</style></head><body><pre id="result">Running</pre><div class="host" id="host"></div>
<script>${script(fs.readFileSync(path.join(root, "node_modules", "react", "umd", "react.production.min.js"), "utf8"))}</script>
<script>${script(fs.readFileSync(path.join(root, "node_modules", "react-dom", "umd", "react-dom.production.min.js"), "utf8"))}</script>
<script>
const MODULES = ${JSON.stringify(modules).replace(/</g, "\\u003c")};
const FIXTURE = ${JSON.stringify(fixture).replace(/</g, "\\u003c")};
const cache = {};
function require(name) {
  if (name === "react") return window.React;
  const key = name.replace(/^\\.\\//, "").replace(/^\\.\\.\\//, "");
  const resolved = MODULES[key] !== undefined ? key : MODULES["src/" + key] !== undefined ? "src/" + key : key;
  if (!cache[resolved]) { const module = { exports: {} }; cache[resolved] = module; new Function("exports", "require", "module", MODULES[resolved])(module.exports, require, module); }
  return cache[resolved].exports;
}
${script(fs.readFileSync(path.join(__dirname, "gantt.browser.js"), "utf8"))}
</script></body></html>`;
const page = path.join(output, "gantt-browser.html");
fs.writeFileSync(page, html);

function run(shot) {
  const result = spawnSync(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--force-device-scale-factor=1",
    `--user-data-dir=${path.join(output, `profile-${process.pid}-${shot || "all"}`)}`, "--window-size=1366,768", "--virtual-time-budget=30000",
    ...(shot ? [`--screenshot=${path.join(output, `${shot}-100pct.png`)}`] : []), "--dump-dom", pathToFileURL(page).href + (shot ? `?shot=${shot}` : "")],
  { encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  assert.ifError(result.error);
  const match = /<pre id="result">(.*?)<\/pre>/s.exec(result.stdout);
  assert.ok(match, result.stderr);
  const report = JSON.parse(match[1].replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  fs.writeFileSync(path.join(output, `results-${shot || "all"}.json`), JSON.stringify(report, null, 2));
  assert.strictEqual(report.pass, true, `${report.error}\n${report.stack}`);
  return report;
}

const report = run();
console.log(`Browser scenarios passed: ${report.checks} checks.`);
report.notes.forEach(note => console.log(`  - ${note}`));
for (const shot of ["portfolio", "filtered", "collapsed", "tasks", "deadlines", "subgrid", "popover"]) run(shot);
console.log(`Screenshots: ${output}`);
