const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { Fabricator, generate, generateToDisk, writeDocuments } = require("../generator");

const definitionsDirectory = path.join(__dirname, "..", "definitions");
const baseConfig = {
  maxDepth: 1,
  maxArrayLength: 1,
  prunePossibility: 0,
};

test("materializes inherited classes and schema-aware functions", () => {
  const colors = ["blue", "green", "red"];
  for (const className of ["Vehicle", "Car", "Boat"]) {
    const documents = generate(`<class:${className}>`, { config: baseConfig });
    assert.equal(documents.length, 20);
    for (const document of documents) {
      assert.equal(typeof document.id, "string");
      assert.ok(document.id.length > 0);
      assert.ok(Number.isInteger(document.speed));
      assert.ok(document.speed >= 0 && document.speed <= 120);
      assert.equal(document.oneMoreThanSpeed, document.speed + 1);
      assert.deepEqual(document.sortedColors, colors);
    }
    if (className === "Car") assert.ok(documents.every((document) => document.numberPlate === ""));
    if (className === "Boat") assert.ok(documents.every((document) => document.weight === 0));
  }
});

test("honors pruning boundaries without expanding fully pruned classes", () => {
  const unpruned = new Fabricator(definitionsDirectory, baseConfig);
  assert.equal([...unpruned.expand("<class:Vehicle>", 0)].length, 20);

  const pruned = generate("<class:Vehicle>", {
    config: { ...baseConfig, prunePossibility: 1 },
  });
  assert.deepEqual(pruned, []);
});

test("builds a multiplicative possibility tree before expansion", () => {
  const fabricator = new Fabricator(definitionsDirectory, {
    ...baseConfig,
    maxDepth: 2,
  });
  const tree = fabricator.buildPossibilityTree("<class:Driver>");

  assert.equal(tree.type, "class");
  assert.equal(tree.name, "Driver");
  assert.equal(tree.possibilities, 205n);
  assert.deepEqual(
    tree.properties.map(({ name, possibilities }) => [name, possibilities]),
    [["name", 1n], ["drivesVehicles", 41n], ["shirtColors", 5n]]
  );
  assert.equal(tree.properties[1].choices.type, "array");
  assert.deepEqual(
    tree.properties[1].choices.lengths.map(({ length, possibilities }) => [length, possibilities]),
    [[0, 1n], [1, 40n]]
  );
  assert.equal(fabricator.exactDocumentCount("<class:Driver>", tree), 205n);
});

test("validates named tokens and circular unions", () => {
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

test("streams documents to disk and reports progress", () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-test-"));
  const progress = [];
  try {
    const total = writeDocuments((function* documents() {
      yield { id: 1 };
      yield { id: 2 };
    }()), outputDirectory, {
      onProgress: (current, expectedTotal) => progress.push([current, expectedTotal]),
    });
    assert.equal(total, 2);
    assert.deepEqual(fs.readdirSync(outputDirectory).sort(), ["tree-0001.json", "tree-0002.json"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDirectory, "tree-0002.json"), "utf8")), { id: 2 });
    assert.deepEqual(progress, [[1, undefined], [2, undefined]]);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("streams documents while expansion is still in progress", () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-output-"));
  const stackDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-stack-"));
  fs.writeFileSync(path.join(stackDirectory, "stale.json"), "{}");
  const completed = [];
  const progress = [];
  try {
    const total = generateToDisk((function* documents() {
      assert.deepEqual(fs.readdirSync(stackDirectory), []);
      yield { id: 1 };
      yield { id: 2 };
    }()), outputDirectory, stackDirectory, {
      total: 2,
      onComplete: (count) => completed.push(count),
      onProgress: (current, expectedTotal) => progress.push([current, expectedTotal]),
    });
    assert.equal(total, 2);
    assert.deepEqual(completed, [2]);
    assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
    assert.deepEqual(fs.readdirSync(stackDirectory), []);
    assert.deepEqual(fs.readdirSync(outputDirectory).sort(), ["tree-0001.json", "tree-0002.json"]);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.rmSync(stackDirectory, { recursive: true, force: true });
  }
});

test("checkpoints deep expansion work to disk", () => {
  const stackDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-expansion-"));
  try {
    const fabricator = new Fabricator(definitionsDirectory, {
      ...baseConfig,
      maxDepth: 2,
    });
    const documents = [...fabricator.generateTreesFromDisk("<class:Vehicle>", stackDirectory)];
    assert.equal(documents.length, 20);
    assert.ok(documents.every((document) => document.oneMoreThanSpeed === document.speed + 1));
    assert.ok(documents.every((document) => document.sortedColors.join(",") === "blue,green,red"));
    assert.deepEqual(fs.readdirSync(stackDirectory), []);
  } finally {
    fs.rmSync(stackDirectory, { recursive: true, force: true });
  }
});

test("does not stage completed documents when cleanup is disabled", () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-output-"));
  const stackDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-stack-"));
  try {
    generateToDisk([{ id: 1 }], outputDirectory, stackDirectory, {
      cleanUpStackAfterGeneration: false,
    });
    assert.deepEqual(fs.readdirSync(stackDirectory), []);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.rmSync(stackDirectory, { recursive: true, force: true });
  }
});

test("uses disk checkpoints end-to-end for generated documents", () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-output-"));
  const stackDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-stack-"));
  try {
    const fabricator = new Fabricator(definitionsDirectory, {
      ...baseConfig,
      maxDepth: 2,
    });
    const total = generateToDisk(
      fabricator.generateTreesFromDisk("<class:Driver>", path.join(stackDirectory, "expansion")),
      outputDirectory,
      stackDirectory,
      { total: 205 }
    );
    assert.equal(total, 205);
    assert.equal(fs.readdirSync(outputDirectory).length, 205);
    assert.deepEqual(fs.readdirSync(stackDirectory), []);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.rmSync(stackDirectory, { recursive: true, force: true });
  }
});

test("resumes from the saved expansion checkpoint without rewriting documents", () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-output-"));
  const stackDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-stack-"));
  const expansionDirectory = path.join(stackDirectory, "expansion");
  try {
    const config = { ...baseConfig, cleanUpStackAfterGeneration: false };
    const firstRun = new Fabricator(definitionsDirectory, config);
    assert.throws(() => generateToDisk(
      firstRun.generateTreesFromDisk("<class:Vehicle>", expansionDirectory),
      outputDirectory,
      stackDirectory,
      {
        cleanUpStackAfterGeneration: false,
        total: 20,
        onProgress: (current) => {
          if (current === 3) throw new Error("stop after a checkpoint");
        },
      }
    ), /stop after a checkpoint/);
    assert.equal(fs.readdirSync(outputDirectory).length, 3);
    assert.ok(fs.readdirSync(expansionDirectory).length > 0);

    const resumedRun = new Fabricator(definitionsDirectory, config);
    const total = generateToDisk(
      resumedRun.generateTreesFromDisk("<class:Vehicle>", expansionDirectory, { resume: true }),
      outputDirectory,
      stackDirectory,
      { cleanUpStackAfterGeneration: false, resume: true, total: 20 }
    );
    assert.equal(total, 20);
    assert.equal(fs.readdirSync(outputDirectory).length, 20);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.rmSync(stackDirectory, { recursive: true, force: true });
  }
});

test("cleans the disk stack when expansion fails", () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-output-"));
  const stackDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "schema-fabricator-stack-"));
  try {
    assert.throws(() => generateToDisk((function* documents() {
      yield { id: 1 };
      throw new Error("intentional expansion failure");
    }()), outputDirectory, stackDirectory), /intentional expansion failure/);
    assert.deepEqual(fs.readdirSync(stackDirectory), []);
    assert.throws(
      () => generateToDisk([], outputDirectory, outputDirectory),
      /outputDirectory and stackDirectory must be different directories/
    );
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.rmSync(stackDirectory, { recursive: true, force: true });
  }
});
