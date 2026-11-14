// Static in-place upgrade checks: a form configured against 3.2.1 must still be valid against the new manifest.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const attrs = text => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));

function parseManifest(xml) {
  const typeGroups = Object.fromEntries([...xml.matchAll(/<type-group name="([^"]+)">([\s\S]*?)<\/type-group>/g)]
    .map(match => [match[1], [...match[2].matchAll(/<type>([^<]+)<\/type>/g)].map(type => type[1].trim())]));
  const propertySets = [...xml.matchAll(/<property-set\s([^>]*?)\/>/g)].map(match => attrs(match[1]));
  return {
    control: attrs(/<control\s([^>]*)>/.exec(xml)[1]),
    dataSet: attrs(/<data-set\s([^>]*)>/.exec(xml)[1]),
    typeGroups,
    propertySets: Object.fromEntries(propertySets.map(set => [set.name, set])),
    properties: Object.fromEntries([...xml.matchAll(/<property\s([^>]*?)\/>/g)].map(match => attrs(match[1])).map(p => [p.name, p])),
    domains: [...xml.matchAll(/<domain>([^<]+)<\/domain>/g)].map(match => match[1]),
    resources: /<resources>([\s\S]*?)<\/resources>/.exec(xml)[1].replace(/\s+/g, " ").trim(),
    features: /<feature-usage>([\s\S]*?)<\/feature-usage>/.exec(xml)[1].replace(/\s+/g, " ").trim()
  };
}

const accepted = (manifest, set) => set["of-type"] ? [set["of-type"]] : manifest.typeGroups[set["of-type-group"]] || [];
const isRequired = set => String(set.required).toLowerCase() === "true";
const version = text => text.split(".").map(Number);
const newer = (a, b) => { for (let i = 0; i < 3; i += 1) { if (a[i] !== b[i]) return a[i] > b[i]; } return false; };

const readFixture = name => parseManifest(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
const previous = readFixture("ControlManifest.3.2.1.xml");
const current = parseManifest(fs.readFileSync(path.join(__dirname, "..", "TaskGantt", "ControlManifest.Input.xml"), "utf8"));

// Forms may have been configured against 3.2.1, 3.3.0 or 3.4.0; all must upgrade in place.
for (const [label, older] of [["3.2.1", previous], ["3.3.0", readFixture("ControlManifest.3.3.0.xml")], ["3.4.0", readFixture("ControlManifest.3.4.0.xml")]]) {
  // Control identity is unchanged, so solutions upgrade the existing control in place.
  ["namespace", "constructor", "control-type"].forEach(key => assert.strictEqual(current.control[key], older.control[key], `${label}: ${key}`));
  assert.ok(newer(version(current.control.version), version(older.control.version)), `manifest version must be newer than ${label}`);
  assert.strictEqual(current.dataSet.name, older.dataSet.name);
  assert.strictEqual(current.dataSet["cds-data-set-options"], older.dataSet["cds-data-set-options"]);

  // Every existing binding stays valid: same property-set name, same usage, every previously accepted type still accepted.
  Object.values(older.propertySets).forEach(oldSet => {
    const newSet = current.propertySets[oldSet.name];
    assert.ok(newSet, `${label}: property-set ${oldSet.name} must not be removed or renamed`);
    assert.strictEqual(newSet.usage, oldSet.usage);
    accepted(older, oldSet).forEach(type => assert.ok(accepted(current, newSet).includes(type), `${label}: ${oldSet.name} still accepts ${type}`));
  });

  // Nothing becomes newly required, so saved configurations remain complete.
  Object.values(current.propertySets).forEach(set => {
    const old = older.propertySets[set.name];
    if (isRequired(set)) assert.ok(old && isRequired(old), `${label}: ${set.name} must not become a new required binding`);
  });
  Object.values(current.properties).forEach(property => {
    const old = older.properties[property.name];
    if (isRequired(property)) assert.ok(old && isRequired(old), `${label}: ${property.name} must not become a new required property`);
  });
  assert.deepStrictEqual(current.properties.licenseKey, older.properties.licenseKey, `${label}: license key property unchanged`);
  assert.deepStrictEqual(current.domains, older.domains, `${label}: license domain unchanged`);
}

// Phase 2 mappings are optional and typed for their purpose.
assert.deepStrictEqual(accepted(current, current.propertySets.parent), ["Lookup.Simple"]);
assert.deepStrictEqual(accepted(current, current.propertySets.milestone), ["TwoOptions"]);
assert.deepStrictEqual(accepted(current, current.propertySets.sequence), ["Whole.None", "Decimal", "FP"]);
["parent", "milestone", "sequence"].forEach(name => assert.strictEqual(isRequired(current.propertySets[name]), false, `${name} is optional`));

// Phase 3 dependency settings are optional inputs; lines default to Auto.
const manifestXml = fs.readFileSync(path.join(__dirname, "..", "TaskGantt", "ControlManifest.Input.xml"), "utf8");
const modeBlock = /<property name="dependencyMode"([^>]*)>([\s\S]*?)<\/property>/.exec(manifestXml);
assert.ok(modeBlock, "dependencyMode exists");
const modeAttrs = attrs(modeBlock[1]);
assert.strictEqual(modeAttrs["of-type"], "Enum");
assert.strictEqual(modeAttrs.usage, "input");
assert.strictEqual(isRequired(modeAttrs), false);
assert.strictEqual(modeAttrs["default-value"], "auto");
assert.deepStrictEqual([...modeBlock[2].matchAll(/<value name="([^"]+)"/g)].map(m => m[1]), ["auto", "off"]);
// Dataverse rejects apostrophes in manifest display and description text at import (XSD type noAposStringType),
// including entity-encoded ones, although the local build accepts them.
const decodeXml = text => text
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
  .replace(/&apos;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const textAttributes = [...manifestXml.matchAll(/\b(display-name-key|description-key)="([^"]*)"/g)].map(m => ({ name: m[1], value: decodeXml(m[2]) }));
assert.ok(textAttributes.length > 20, "display and description text found");
textAttributes.forEach(({ name, value }) => assert.ok(!value.includes("'"), `${name} must not contain an apostrophe: ${value}`));
assert.ok(decodeXml("a&apos;b&#39;c&#x27;d").split("'").length === 4, "decoder handles all apostrophe encodings");

["dependencyTable", "dependencyPredecessorColumn", "dependencySuccessorColumn"].forEach(name => {
  const property = current.properties[name];
  assert.ok(property, `${name} exists`);
  assert.strictEqual(property["of-type"], "SingleLine.Text");
  assert.strictEqual(property.usage, "input");
  assert.strictEqual(isRequired(property), false, `${name} is optional`);
});

// Phase 1 contract: only Title, Start and Finish are required.
assert.deepStrictEqual(Object.values(current.propertySets).filter(isRequired).map(set => set.name).sort(), ["scheduledend", "scheduledstart", "subject"]);
["ownerid", "statecode", "createdon", "description"].forEach(name => {
  assert.ok(current.propertySets[name], `${name} exists`);
  assert.strictEqual(isRequired(current.propertySets[name]), false, `${name} is optional`);
});
["scheduledstart", "scheduledend"].forEach(name => {
  const types = accepted(current, current.propertySets[name]);
  assert.ok(types.includes("DateAndTime.DateAndTime") && types.includes("DateAndTime.DateOnly"), `${name} binds Date Only and Date and Time`);
});
assert.deepStrictEqual(accepted(current, current.propertySets.subject), ["SingleLine.Text"]);

// Licensing, resources and features are untouched.
assert.deepStrictEqual(current.properties.licenseKey, previous.properties.licenseKey);
assert.deepStrictEqual(current.domains, previous.domains);
assert.strictEqual(current.resources, previous.resources);
assert.strictEqual(current.features, previous.features);

// Simulated saved configurations.
const isValidConfiguration = bindings => Object.entries(bindings).every(([setName, type]) => {
  const set = current.propertySets[setName];
  return set && accepted(current, set).includes(type);
}) && Object.values(current.propertySets).filter(isRequired).every(set => bindings[set.name]);

assert.ok(isValidConfiguration({
  subject: "SingleLine.Text",
  scheduledend: "DateAndTime.DateAndTime",
  ownerid: "Lookup.Owner",
  statecode: "OptionSet",
  scheduledstart: "DateAndTime.DateAndTime",
  createdon: "DateAndTime.DateAndTime"
}), "existing standard Tasks configuration");
assert.ok(isValidConfiguration({
  subject: "SingleLine.Text",
  scheduledstart: "DateAndTime.DateOnly",
  scheduledend: "DateAndTime.DateOnly"
}), "minimal custom table configuration");
assert.ok(isValidConfiguration({
  subject: "SingleLine.Text",
  scheduledstart: "DateAndTime.DateOnly",
  scheduledend: "DateAndTime.DateOnly",
  parent: "Lookup.Simple",
  milestone: "TwoOptions",
  sequence: "Decimal"
}), "custom table with hierarchy mappings");
assert.ok(!isValidConfiguration({ subject: "SingleLine.Text", scheduledstart: "DateAndTime.DateOnly" }), "Finish stays required");

console.log("Manifest upgrade tests passed.");
