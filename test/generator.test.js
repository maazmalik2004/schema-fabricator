const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  Fabricator,
  formatBytes,
  generate,
  writeDocuments,
  writeDocumentsLive,
} = require("../generator");
const {
  createSpinner,
  formatConfirmationPrompt,
  formatConfiguration,
  formatGenerationProgress,
  isAffirmative,
  prepareOutputDirectory,
  runCli,
} = require("../cli");
const { deferredFunction } = require("../parser");

const definitionsDirectory = path.join(__dirname, "..", "definitions");
const baseConfig = { maxDepth: 1, maxArrayLength: 1 };

test("covers inherited-class decisions while preserving schema-aware functions", () => {
  const fabricator = new Fabricator(definitionsDirectory, { ...baseConfig, random: () => 0 });
  const documents = fabricator.generate("<class:Car>");
  assert.equal(documents.length, 5);
  assert.ok(documents.every((document) => document.numberPlate === ""));
  assert.ok(documents.every((document) => document.oneMoreThanSpeed === document.speed + 1));
  assert.ok(documents.every((document) => document.sortedColors.join(",") === "blue,green,red"));
  assert.deepEqual([...new Set(documents.map((document) => document.numberOfSeats))].sort(), [3, 4, 5, 6, 7]);
  assert.deepEqual([...new Set(documents.flatMap((document) => document.colors))].sort(), ["blue", "green", "red"]);
});

test("expands tags and optional properties at every nesting level", () => {
  const fabricator = new Fabricator(definitionsDirectory, { ...baseConfig, random: () => 0 });
  fabricator.loader.functionCache.set("constant", () => () => "computed");
  const documents = fabricator.generate({
    nested: {
      color: "<enum:Color>",
      "label?": "<function:constant>",
      fixed: ["<Number>", "<Boolean>"],
    },
  });
  assert.equal(documents.length, 3);
  assert.ok(documents.some(({ nested }) => !Object.hasOwn(nested, "label")));
  assert.ok(documents.some(({ nested }) => nested.label === "computed"));
  assert.ok(documents.every(({ nested }) => nested.fixed[0] === 0 && nested.fixed[1] === false));
});

test("covers independent decisions without generating their Cartesian product", () => {
  const fabricator = new Fabricator(definitionsDirectory, { ...baseConfig, random: () => 0 });
  const documents = fabricator.generate({ color: "<enum:Color>", seats: "<enum:Seats>" });

  assert.equal(documents.length, 5);
  assert.deepEqual([...new Set(documents.map((document) => document.color))].sort(), ["blue", "green", "red"]);
  assert.deepEqual([...new Set(documents.map((document) => document.seats))].sort(), [3, 4, 5, 6, 7]);
  assert.equal(documents.filter((document) => document.color === "red").length, 3);
  const colorDecision = fabricator.occurrenceTree.decisions.find(({ decision }) => decision === "enum:$.color:Color");
  assert.equal(colorDecision.branches.find(({ value }) => value === "red").occurrences, 1);
  assert.ok(fabricator.occurrenceTree.decisions.every(({ branches }) => branches.every((branch) => branch.occurrences >= 1 && branch.pruned)));
});

test("keeps one occurrence tree for an entire generation run", () => {
  const fabricator = new Fabricator(definitionsDirectory, { ...baseConfig, random: () => 0 });
  const documents = fabricator.generateTrees({ color: "<enum:Color>", seats: "<enum:Seats>" });
  documents.next();
  const occurrenceTree = fabricator.occurrenceTree;
  documents.next();
  assert.strictEqual(fabricator.occurrenceTree, occurrenceTree);
  [...documents];
  assert.ok(occurrenceTree.pruned);
});

test("reports fulfilled coverage branches from the shared occurrence tree", () => {
  const fabricator = new Fabricator(definitionsDirectory, { ...baseConfig, random: () => 0 });
  const documents = fabricator.generateTrees("<enum:Color>");

  documents.next();
  assert.deepEqual(fabricator.coverageStats(), { fulfilled: 1, total: 3, percentage: 33 });
  [...documents];
  assert.deepEqual(fabricator.coverageStats(), { fulfilled: 3, total: 3, percentage: 100 });
});

test("randomly covers and prunes every optional include and exclude branch", () => {
  const fabricator = new Fabricator(definitionsDirectory, {
    ...baseConfig,
    minOccurances: 2,
    random: () => 0,
  });
  const documents = fabricator.generate({ "color?": "<enum:Color>" });

  assert.equal(documents.length, 8);
  assert.equal(documents.filter((document) => !Object.hasOwn(document, "color")).length, 2);
  for (const color of ["red", "blue", "green"]) {
    assert.equal(documents.filter((document) => document.color === color).length, 2);
  }

  const optionalDecision = fabricator.occurrenceTree.decisions.find(({ decision }) => decision === "optional:$.color");
  assert.equal(optionalDecision.decision, "optional:$.color");
  assert.deepEqual(
    optionalDecision.branches.map(({ value, occurrences, pruned }) => ({ value, occurrences, pruned })),
    [
      { value: "exclude", occurrences: 2, pruned: true },
      { value: "include", occurrences: 6, pruned: true },
    ]
  );
  assert.ok(fabricator.occurrenceTree.pruned);
});

test("shares one occurrence tree across optional, array, union, and enum decisions", () => {
  const fabricator = new Fabricator(definitionsDirectory, {
    maxDepth: 1,
    maxArrayLength: 1,
    minOccurances: 2,
    random: () => 0,
  });
  const documents = fabricator.generate({ "vehicles?": "[<union:Vehicle>]" });

  assert.ok(documents.length > 0);
  assert.ok(fabricator.occurrenceTree.decisions.some(({ decision }) => decision.startsWith("optional:")));
  assert.ok(fabricator.occurrenceTree.decisions.some(({ decision }) => decision.startsWith("array:")));
  assert.ok(fabricator.occurrenceTree.decisions.some(({ decision }) => decision.startsWith("union:")));
  assert.ok(fabricator.occurrenceTree.decisions.some(({ decision }) => decision.startsWith("enum:")));
  assert.ok(fabricator.occurrenceTree.decisions.every(({ branches }) => branches.every((branch) => branch.occurrences >= 2 && branch.pruned)));
  assert.ok(fabricator.occurrenceTree.pruned);
});

test("builds an exact multiplicative possibility tree", () => {
  const fabricator = new Fabricator(definitionsDirectory, baseConfig);
  const tree = fabricator.buildPossibilityTree("<class:Driver>");
  assert.equal(tree.type, "class");
  assert.equal(tree.name, "Driver");
  assert.equal(tree.possibilities, 15n);
});

test("passes multiple schema arguments to functions", () => {
  const fabricator = new Fabricator(definitionsDirectory, baseConfig);
  fabricator.loader.functionCache.set("combine", () => (vehicle, colors) => `${vehicle.speed}:${colors[0]}`);
  const value = deferredFunction("combine", ["schema.class.Vehicle", "schema.enum.Color"]);
  assert.equal(fabricator.materializeFunction(value, new Map([["Vehicle", { speed: 12 }]])), "12:red");
});

test("streams generated documents to the output directory", () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-output-"));
  try {
    const progress = [];
    fs.writeFileSync(path.join(outputDirectory, "tree-000000000099.json"), "stale");
    fs.writeFileSync(path.join(outputDirectory, "notes.txt"), "stale");
    assert.equal(writeDocuments([{ id: 1 }, { id: 2 }], outputDirectory, {
      onProgress: (status) => progress.push(status),
    }), 2);
    assert.deepEqual(fs.readdirSync(outputDirectory).sort(), [
      "tree-000000000001.json",
      "tree-000000000002.json",
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDirectory, "tree-000000000002.json"), "utf8")), { id: 2 });
    assert.deepEqual(progress.map(({ count }) => count), [0, 1, 2]);
    assert.ok(progress.at(-1).bytes > 0);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("yields to the event loop while streaming live output", async () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-live-output-"));
  try {
    let yielded = false;
    setImmediate(() => { yielded = true; });
    await writeDocumentsLive(Array.from({ length: 100 }, (_, id) => ({ id })), outputDirectory);
    assert.equal(yielded, true);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("formats generated byte counts for progress output", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.00 KB");
  assert.equal(formatBytes(1024 ** 2), "1.00 MB");
});

test("formats generation progress with explicit coverage totals", () => {
  assert.equal(
    formatGenerationProgress({
      count: 12,
      bytes: 1024,
      coverage: { fulfilled: 4, total: 12, percentage: 33 },
    }),
    "12  1.00 KB  coverage-33% (4/12 decision branches)",
  );
});

test("formats CLI configuration and accepts only affirmative responses", () => {
  assert.equal(formatConfiguration({ root: "<String>", maxDepth: 2 }), '  root: "<String>"\n  maxDepth: 2');
  assert.equal(formatConfirmationPrompt({ isTTY: false }), "Proceed with generation [y/n/yes/no]: ");
  assert.equal(formatConfirmationPrompt({ isTTY: true }), "Proceed with generation \x1b[31m[y/n/yes/no]\x1b[0m: ");
  assert.equal(isAffirmative("Y"), true);
  assert.equal(isAffirmative(" yes "), true);
  assert.equal(isAffirmative("n"), false);
});

test("validates coverage configuration and random values", () => {
  assert.throws(
    () => new Fabricator(definitionsDirectory, { ...baseConfig, minOccurances: 0 }),
    /minOccurances must be a positive integer/
  );
  const fabricator = new Fabricator(definitionsDirectory, { ...baseConfig, random: () => 1 });
  assert.throws(() => fabricator.generate("<enum:Color>"), /random must return a number/);
});

test("prepares output directories and reports whether it creates or clears them", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-cli-"));
  const outputDirectory = path.join(temporaryDirectory, "generated");
  let output = "";
  const stream = { write: (line) => { output += line; } };
  try {
    prepareOutputDirectory(outputDirectory, stream);
    assert.match(output, /Creating/);
    fs.writeFileSync(path.join(outputDirectory, "stale.json"), "stale");

    output = "";
    prepareOutputDirectory(outputDirectory, stream);
    assert.match(output, /Deleting files/);
    assert.deepEqual(fs.readdirSync(outputDirectory), []);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("CLI estimates coverage, confirms, and generates into a prepared directory", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-cli-"));
  const outputDirectory = path.join(temporaryDirectory, "generated");
  let output = "";
  const stream = {
    isTTY: false,
    write: (line) => { output += line; },
  };
  try {
    const count = await runCli({
      config: { root: "<String>", ...baseConfig, minOccurances: 3 },
      definitionsDirectory,
      outputDirectory,
      output: stream,
      confirm: async () => true,
    });
    assert.equal(count, 1);
    assert.match(output, /✓ Loading definitions:/);
    assert.match(output, /✓ Planning possible documents:/);
    assert.match(output, /✓ Preparing output directory:/);
    assert.match(output, /Estimated number of possible documents: 1/);
    assert.match(output, /Configuration:/);
    assert.match(output, /Coverage-based pruning is enabled: each decision branch targets 3 occurrence\(s\)/);
    assert.match(output, /Creating/);
    assert.match(output, /Generated 1 document\(s\)/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(outputDirectory, "tree-000000000001.json"), "utf8")), "");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("CLI reports live coverage against all discovered decision branches", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-cli-"));
  const outputDirectory = path.join(temporaryDirectory, "generated");
  let output = "";
  const stream = {
    isTTY: false,
    write: (line) => { output += line; },
  };
  try {
    await runCli({
      config: { root: "<enum:Color>", ...baseConfig },
      definitionsDirectory,
      outputDirectory,
      output: stream,
      confirm: async () => true,
    });
    assert.match(output, /Generating documents: 3.*coverage-100% \(3\/3 decision branches\)/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("CLI cancellation preserves an existing output directory", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-cli-"));
  const outputDirectory = path.join(temporaryDirectory, "generated");
  fs.mkdirSync(outputDirectory);
  fs.writeFileSync(path.join(outputDirectory, "keep.json"), "keep");
  let output = "";
  const stream = { isTTY: false, write: (line) => { output += line; } };
  try {
    const count = await runCli({
      config: { root: "<String>", ...baseConfig },
      definitionsDirectory,
      outputDirectory,
      output: stream,
      confirm: async () => false,
    });
    assert.equal(count, 0);
    assert.equal(fs.readFileSync(path.join(outputDirectory, "keep.json"), "utf8"), "keep");
    assert.doesNotMatch(output, /Deleting files/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("CLI terminates TTY progress before its generation summary", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-cli-"));
  const outputDirectory = path.join(temporaryDirectory, "generated");
  let output = "";
  const stream = { isTTY: true, write: (line) => { output += line; } };
  try {
    await runCli({
      config: { root: "<String>", ...baseConfig },
      definitionsDirectory,
      outputDirectory,
      output: stream,
      confirm: async () => true,
    });
    assert.match(output, /✓ Generating documents: 1  3 B  coverage-0% \(0\/0 decision branches\)\nGenerated 1 document\(s\)/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("includes live details in non-TTY spinner output", () => {
  let output = "";
  const spinner = createSpinner("Generating documents", {
    isTTY: false,
    write: (line) => { output += line; },
  });
  spinner.start();
  spinner.update("12  1.00 KB");
  spinner.stop();
  assert.match(output, /⠋ Generating documents:/);
  assert.match(output, /✓ Generating documents: 12  1\.00 KB/);
});

test("refreshes TTY spinner details immediately", () => {
  let output = "";
  const spinner = createSpinner("Generating documents", {
    isTTY: true,
    write: (line) => { output += line; },
  });
  spinner.start();
  spinner.update("12  1.00 KB");
  spinner.stop();
  assert.match(output, /Generating documents: 12  1\.00 KB/);
});

test("shares loaded state across functions", () => {
  const temporaryDefinitions = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-state-"));
  try {
    fs.cpSync(definitionsDirectory, temporaryDefinitions, { recursive: true });
    const stateDirectory = path.join(temporaryDefinitions, "state");
    fs.mkdirSync(stateDirectory, { recursive: true });
    fs.writeFileSync(path.join(stateDirectory, "Counter.state.json"), JSON.stringify({ value: 0 }));

    const fabricator = new Fabricator(temporaryDefinitions, baseConfig);
    fabricator.loader.functionCache.set("increment", (schema) => () => ++schema.state.Counter.value);
    fabricator.loader.functionCache.set("read", (schema) => () => schema.state.Counter.value);
    assert.deepEqual(fabricator.generate({ first: "<function:increment>", second: "<function:read>" }), [{ first: 1, second: 1 }]);
  } finally {
    fs.rmSync(temporaryDefinitions, { recursive: true, force: true });
  }
});

test("validates malformed tags and circular unions", () => {
  for (const token of ["<class>", "<union>", "<enum>", "<function>"]) {
    assert.throws(() => generate(token, { config: baseConfig }), /token must include a name/);
  }
  const fabricator = new Fabricator(definitionsDirectory, baseConfig);
  fabricator.classes.set("Loop", {
    filename: "<memory>/Loop.class.json",
    name: "Loop",
    properties: { child: "<union:Loop>" },
  });
  fabricator.unions.set("Loop", ["<class:Loop>"]);
  assert.throws(() => [...fabricator.generateTrees("<union:Loop>")], /Circular union: Loop/);
});
