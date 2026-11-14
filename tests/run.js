// Runs every *.test.js file once per time zone so Date Only handling is checked west and east of UTC.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ZONES = ["UTC", "Pacific/Pago_Pago", "America/Los_Angeles", "Europe/Sofia", "Asia/Kolkata", "Pacific/Kiritimati"];
const files = fs.readdirSync(__dirname).filter(file => file.endsWith(".test.js")).sort();
let failures = 0;

for (const zone of ZONES) {
  for (const file of files) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
      env: { ...process.env, TZ: zone },
      encoding: "utf8"
    });
    const ok = result.status === 0;
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  [${zone}] ${file}`);
    if (!ok) process.stdout.write(`${result.stdout}${result.stderr}\n`);
  }
}

console.log(`\n${files.length} test files x ${ZONES.length} time zones, ${failures} failed.`);
process.exit(failures ? 1 : 0);
