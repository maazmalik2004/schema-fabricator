const fs = require("fs");
const path = require("path");
const { DefinitionLoader, readJson } = require("./loader");
const {
  deferredFunction,
  deferredFunctionArguments,
  deferredFunctionName,
  isDeferredFunction,
  parseDefinition,
  parseFunctionReference,
  propertyName,
  requiredTokenName,
  unique,
} = require("./parser");

class Fabricator {
  constructor(definitionsDirectory, { maxDepth, maxArrayLength, minOccurances = 1, random = Math.random }) {
    if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error("maxDepth must be a positive integer.");
    if (!Number.isInteger(maxArrayLength) || maxArrayLength < 0) throw new Error("maxArrayLength must be a non-negative integer.");
    if (!Number.isInteger(minOccurances) || minOccurances < 1) throw new Error("minOccurances must be a positive integer.");
    if (typeof random !== "function") throw new Error("random must be a function.");

    this.maxDepth = maxDepth;
    this.maxArrayLength = maxArrayLength;
    this.minOccurances = minOccurances;
    this.random = random;
    this.loader = new DefinitionLoader(definitionsDirectory);
    ({
      classes: this.classes,
      enums: this.enums,
      unions: this.unions,
      state: this.state,
      schemaDefinitions: this.schemaDefinitions,
    } = this.loader.load());
    this.classPropertiesCache = new Map();
    this.classHierarchyCache = new Map();
    this.classInstanceNames = new WeakMap();
  }

  classProperties(className, visited = new Set()) {
    if (this.classPropertiesCache.has(className)) return this.classPropertiesCache.get(className);
    const record = this.classes.get(className);
    if (!record) throw new Error(`Unknown class: ${className}`);
    if (visited.has(record.filename)) throw new Error(`Circular class inheritance involving ${className}`);
    if (!record.properties || Array.isArray(record.properties) || typeof record.properties !== "object") {
      throw new Error(`Class ${className} must contain a JSON object.`);
    }

    this.normalizeEntries(Object.entries(record.properties), `Class ${className}`);

    const properties = record.parent
      ? { ...this.classProperties(record.parent.name, new Set(visited).add(record.filename)) }
      : {};
    for (const [rawKey, definition] of Object.entries(record.properties)) {
      const key = propertyName(rawKey);
      for (const inheritedKey of Object.keys(properties)) {
        if (propertyName(inheritedKey) === key) delete properties[inheritedKey];
      }
      properties[rawKey] = definition;
    }
    this.classPropertiesCache.set(className, properties);
    return properties;
  }

  classHierarchy(className) {
    if (this.classHierarchyCache.has(className)) return this.classHierarchyCache.get(className);
    const names = [];
    let record = this.classes.get(className);
    while (record) {
      names.push(record.name);
      record = record.parent;
    }
    this.classHierarchyCache.set(className, names);
    return names;
  }

  normalizeEntries(entries, description) {
    const names = new Set();
    return entries.map(([rawKey, definition]) => {
      const key = propertyName(rawKey);
      if (!key) throw new Error(`${description} has an empty property name.`);
      if (names.has(key)) throw new Error(`${description} defines ${key} more than once (including optional variants).`);
      names.add(key);
      return { key, definition, optional: rawKey.endsWith("?") };
    });
  }

  classEntries(className) {
    return this.normalizeEntries(Object.entries(this.classProperties(className)), `Class ${className}`);
  }

  analyzeSchema(root) {
    let recursive = false;
    const validatedDefinitions = new Set();
    const visitDefinition = (value, visiting) => {
      const parsed = parseDefinition(value);
      if (parsed.type === "literal") return;
      if (parsed.type === "array") return visitDefinition(parsed.item, visiting);
      if (parsed.type === "tuple") {
        for (const item of parsed.values) visitDefinition(item, visiting);
        return;
      }
      if (parsed.type === "object") {
        for (const { definition } of this.normalizeEntries(parsed.entries, "Nested object")) {
          visitDefinition(definition, visiting);
        }
        return;
      }

      const { kind, name, token } = parsed;
      switch (kind) {
        case "String": case "Number": case "Boolean": case "Null": return;
        case "function":
          parseFunctionReference(name, token);
          return;
        case "enum":
          this.definitionValues(this.enums, "Enum", requiredTokenName(kind, name, token));
          return;
        case "class": case "union":
          visitNamed(kind, requiredTokenName(kind, name, token), visiting);
          return;
        default: throw new Error(`Unknown type token: ${token}`);
      }
    };
    const visitNamed = (kind, name, visiting) => {
      const identifier = `${kind}:${name}`;
      if (visiting.has(identifier)) {
        recursive = true;
        return;
      }
      if (validatedDefinitions.has(identifier)) return;
      const next = new Set(visiting).add(identifier);
      const definitions = kind === "class"
        ? this.classEntries(name).map(({ definition }) => definition)
        : this.definitionValues(this.unions, "Union", name);
      for (const definition of definitions) visitDefinition(definition, next);
      validatedDefinitions.add(identifier);
    };

    visitDefinition(root, new Set());
    return { recursive };
  }

  isRecursiveSchema(root) {
    return this.analyzeSchema(root).recursive;
  }

  definitionValues(definitions, type, name) {
    if (!definitions.has(name)) throw new Error(`Unknown ${type.toLowerCase()}: ${name}`);
    const values = definitions.get(name);
    if (!Array.isArray(values)) throw new Error(`${type} ${name} must contain a JSON array.`);
    return values;
  }

  sampleCoverageValue(value, depth, location = "$", resolvingUnions = new Set(), ancestors = [], recursiveDepth = 0) {
    const parsed = parseDefinition(value);
    if (parsed.type === "literal") return parsed.value;
    if (parsed.type === "array") return this.sampleCoverageArray(parsed.item, depth, location, resolvingUnions, ancestors, recursiveDepth);
    if (parsed.type === "tuple") {
      return parsed.values.map((item, index) => this.sampleCoverageValue(item, depth, `${location}[${index}]`, resolvingUnions, ancestors, recursiveDepth));
    }
    if (parsed.type === "object") {
      return this.sampleCoverageEntries(
        this.normalizeEntries(parsed.entries, "Nested object"),
        depth,
        location,
        resolvingUnions,
        ancestors,
        (object) => object,
        recursiveDepth
      );
    }

    const { kind, name, token } = parsed;
    switch (kind) {
      case "String": return "";
      case "Number": return 0;
      case "Boolean": return false;
      case "Null": return null;
      case "function": {
        const reference = parseFunctionReference(name, token);
        return deferredFunction(reference.functionName, reference.argumentPaths);
      }
      case "enum": {
        const enumName = requiredTokenName(kind, name, token);
        const values = unique(this.definitionValues(this.enums, "Enum", enumName));
        return this.selectCoverageBranch(`enum:${location}:${enumName}`, values, (item) => JSON.stringify(item), ancestors).value;
      }
      case "union": {
        const unionName = requiredTokenName(kind, name, token);
        const isRecursiveReference = resolvingUnions.has(unionName);
        if (isRecursiveReference && recursiveDepth >= this.maxDepth - 1) return null;
        const members = unique(this.definitionValues(this.unions, "Union", unionName));
        const branch = this.selectCoverageBranch(`union:${location}:${unionName}`, members, JSON.stringify, ancestors);
        return this.sampleCoverageValue(
          branch.value,
          depth,
          location,
          new Set(resolvingUnions).add(unionName),
          [...ancestors, branch],
          recursiveDepth + (isRecursiveReference ? 1 : 0)
        );
      }
      case "class": return this.sampleCoverageClass(requiredTokenName(kind, name, token), depth + 1, location, resolvingUnions, ancestors, recursiveDepth);
      default: throw new Error(`Unknown type token: ${token}`);
    }
  }

  sampleCoverageArray(itemDefinition, depth, location, resolvingUnions, ancestors, recursiveDepth = 0) {
    const lengths = Array.from({ length: this.maxArrayLength + 1 }, (_, length) => length);
    const branch = this.selectCoverageBranch(`array:${location}`, lengths, String, ancestors);
    return Array.from(
      { length: branch.value },
      (_, index) => this.sampleCoverageValue(itemDefinition, depth, `${location}[${index}]`, resolvingUnions, [...ancestors, branch], recursiveDepth)
    );
  }

  sampleCoverageEntries(entries, depth, location, resolvingUnions, ancestors, complete = (value) => value, recursiveDepth = 0) {
    const object = {};
    for (const { key, definition, optional } of entries) {
      const propertyLocation = `${location}.${key}`;
      if (optional) {
        const branch = this.selectCoverageBranch(`optional:${propertyLocation}`, ["exclude", "include"], (item) => item, ancestors);
        if (branch.value === "exclude") continue;
        object[key] = this.sampleCoverageValue(definition, depth, propertyLocation, resolvingUnions, [...ancestors, branch], recursiveDepth);
        continue;
      }
      object[key] = this.sampleCoverageValue(definition, depth, propertyLocation, resolvingUnions, ancestors, recursiveDepth);
    }
    return complete(object);
  }

  sampleCoverageClass(className, depth, location, resolvingUnions, ancestors, recursiveDepth = 0) {
    if (depth > this.maxDepth) return null;
    return this.sampleCoverageEntries(
      this.classEntries(className),
      depth,
      location,
      resolvingUnions,
      ancestors,
      (object) => {
        this.classInstanceNames.set(object, className);
        return object;
      },
      recursiveDepth
    );
  }

  buildPossibilityTree(value, depth = 0, resolvingUnions = new Set(), recursiveDepth = 0) {
    const leaf = (type, details = {}) => ({ type, possibilities: 1n, ...details });
    const parsed = parseDefinition(value);
    if (parsed.type === "literal") return leaf("literal", { value: parsed.value });
    if (parsed.type === "array") return this.buildArrayPossibilityTree(parsed.item, depth, resolvingUnions, recursiveDepth);
    if (parsed.type === "tuple") return this.buildTuplePossibilityTree(parsed.values, depth, resolvingUnions, recursiveDepth);
    if (parsed.type === "object") return this.buildObjectPossibilityTree(this.normalizeEntries(parsed.entries, "Nested object"), depth, resolvingUnions, recursiveDepth);

    const { kind, name, token } = parsed;
    switch (kind) {
      case "String": case "Number": case "Boolean": case "Null": return leaf("primitive", { kind });
      case "function": {
        const reference = parseFunctionReference(name, token);
        return leaf("function", { name: reference.functionName, argumentPaths: reference.argumentPaths });
      }
      case "enum": {
        const enumName = requiredTokenName(kind, name, token);
        return { type: "enum", name: enumName, possibilities: BigInt(unique(this.definitionValues(this.enums, "Enum", enumName)).length) };
      }
      case "union": {
        const unionName = requiredTokenName(kind, name, token);
        const isRecursiveReference = resolvingUnions.has(unionName);
        if (isRecursiveReference && recursiveDepth >= this.maxDepth - 1) {
          return { type: "union", name: unionName, recursive: true, truncated: true, possibilities: 1n, children: [] };
        }
        const next = new Set(resolvingUnions).add(unionName);
        const children = unique(this.definitionValues(this.unions, "Union", unionName))
          .map((member) => this.buildPossibilityTree(member, depth, next, recursiveDepth + (isRecursiveReference ? 1 : 0)));
        return { type: "union", name: unionName, possibilities: children.reduce((total, child) => total + child.possibilities, 0n), children };
      }
      case "class": return this.buildClassPossibilityTree(requiredTokenName(kind, name, token), depth + 1, resolvingUnions, recursiveDepth);
      default: throw new Error(`Unknown type token: ${token}`);
    }
  }

  buildArrayPossibilityTree(itemDefinition, depth, resolvingUnions, recursiveDepth = 0) {
    const item = this.buildPossibilityTree(itemDefinition, depth, resolvingUnions, recursiveDepth);
    const lengths = [];
    let possibilities = 0n;
    for (let length = 0; length <= this.maxArrayLength; length += 1) {
      const count = item.possibilities ** BigInt(length);
      lengths.push({ length, possibilities: count });
      possibilities += count;
    }
    return { type: "array", possibilities, item, lengths };
  }

  buildTuplePossibilityTree(values, depth, resolvingUnions, recursiveDepth = 0) {
    const children = values.map((value) => this.buildPossibilityTree(value, depth, resolvingUnions, recursiveDepth));
    return {
      type: "tuple",
      possibilities: children.reduce((total, child) => total * child.possibilities, 1n),
      children,
    };
  }

  buildObjectPossibilityTree(entries, depth, resolvingUnions, recursiveDepth = 0) {
    const properties = entries.map(({ key, definition, optional }) => {
      const choices = this.buildPossibilityTree(definition, depth, resolvingUnions, recursiveDepth);
      return { name: key, optional, choices, possibilities: choices.possibilities + (optional ? 1n : 0n) };
    });
    return {
      type: "object",
      possibilities: properties.reduce((total, property) => total * property.possibilities, 1n),
      properties,
    };
  }

  buildClassPossibilityTree(className, depth, resolvingUnions, recursiveDepth = 0) {
    if (depth > this.maxDepth) return { type: "class", name: className, truncated: true, possibilities: 1n, properties: [] };
    const properties = this.classEntries(className).map(({ key, definition, optional }) => {
      const choices = this.buildPossibilityTree(definition, depth, resolvingUnions, recursiveDepth);
      return { name: key, optional, possibilities: choices.possibilities + (optional ? 1n : 0n), choices };
    });
    return { type: "class", name: className, possibilities: properties.reduce((total, property) => total * property.possibilities, 1n), properties };
  }

  generate(root) {
    return Array.from(this.generateTrees(root));
  }

  *generateTrees(root) {
    this.analyzeSchema(root);
    this.occurrenceTree = this.buildOccurrenceTree();
    do {
      const document = this.sampleCoverageValue(root, 0);
      this.refreshOccurrenceTree();
      yield this.materialize(document);
    } while (!this.occurrenceTree.pruned);
  }

  buildOccurrenceTree() {
    this.occurrenceNodes = new Map();
    return { pruned: false, decisions: [] };
  }

  coverageStats() {
    if (!this.occurrenceTree) {
      return { fulfilled: 0, total: 0, percentage: 0 };
    }

    const branches = this.occurrenceTree.decisions.flatMap(({ branches }) => branches);
    const fulfilled = branches.filter(({ pruned }) => pruned).length;
    const total = branches.length;
    return {
      fulfilled,
      total,
      percentage: total ? Math.floor((fulfilled / total) * 100) : 0,
    };
  }

  selectCoverageBranch(decision, values, keyForValue, ancestors) {
    let node = this.occurrenceNodes.get(decision);
    const keys = values.map((value) => keyForValue(value));
    if (!node) {
      node = {
        decision,
        branches: values.map((value, index) => ({
          value,
          key: keys[index],
          occurrences: 0,
          pruned: false,
          descendants: [],
        })),
      };
      this.occurrenceNodes.set(decision, node);
      this.occurrenceTree.decisions.push(node);
    } else if (node.branches.length !== values.length || node.branches.some((branch, index) => branch.key !== keys[index])) {
      throw new Error(`Inconsistent coverage choices for decision: ${decision}`);
    }

    for (const ancestor of ancestors) {
      if (!ancestor.descendants.includes(decision)) ancestor.descendants.push(decision);
    }

    this.refreshOccurrenceTree();
    const eligible = node.branches.filter((branch) => !branch.pruned);
    const branch = this.randomChoice(eligible.length ? eligible : node.branches);
    if (eligible.length) branch.occurrences += 1;
    return branch;
  }

  refreshOccurrenceTree() {
    const completed = this.occurrenceTree.decisions.map((node) => this.isCoverageDecisionComplete(node));
    this.occurrenceTree.pruned = completed.every(Boolean);
  }

  randomChoice(choices) {
    const random = this.random();
    if (!Number.isFinite(random) || random < 0 || random >= 1) throw new Error("random must return a number from 0 (inclusive) to 1 (exclusive).");
    return choices[Math.floor(random * choices.length)];
  }

  isCoverageDecisionComplete(node, visiting = new Set()) {
    if (visiting.has(node.decision)) return false;
    const next = new Set(visiting).add(node.decision);
    for (const branch of node.branches) {
      branch.pruned = branch.occurrences >= this.minOccurances
        && branch.descendants.every((decision) => this.isCoverageDecisionComplete(this.occurrenceNodes.get(decision), next));
    }
    return node.branches.every((branch) => branch.pruned);
  }

  createSchemaContext(classInstances) {
    return {
      class: Object.fromEntries(classInstances),
      enum: this.schemaDefinitions.enum,
      union: this.schemaDefinitions.union,
      state: this.state,
    };
  }

  materializeFunction(value, classInstances, schema = this.createSchemaContext(classInstances)) {
    const functionName = deferredFunctionName(value);
    const implementation = this.loader.loadFunction(functionName)(schema);
    if (typeof implementation !== "function") throw new Error(`Function file ${functionName}.function.js must define ${functionName}.`);
    const args = deferredFunctionArguments(value).map((argumentPath) => this.resolveSchemaArgument(schema, argumentPath));
    return implementation(...args);
  }

  resolveSchemaArgument(schema, argumentPath) {
    return argumentPath.split(".").slice(1).reduce((current, key) => current?.[key], schema);
  }

  materialize(value, classInstances = new Map()) {
    if (isDeferredFunction(value)) return this.materializeFunction(value, classInstances);
    if (Array.isArray(value)) return value.map((item) => this.materialize(item, classInstances));
    if (!value || typeof value !== "object") return value;
    const instances = new Map(classInstances);
    const className = this.classInstanceNames.get(value);
    const materialized = {};
    if (className) {
      for (const name of this.classHierarchy(className)) instances.set(name, materialized);
    }
    const deferred = [];
    for (const [key, item] of Object.entries(value)) {
      if (isDeferredFunction(item)) {
        materialized[key] = undefined;
        deferred.push([key, item]);
      } else {
        materialized[key] = this.materialize(item, instances);
      }
    }
    const schema = deferred.length ? this.createSchemaContext(instances) : undefined;
    for (const [key, item] of deferred) materialized[key] = this.materializeFunction(item, instances, schema);
    return materialized;
  }
}

function generate(root, options = {}) {
  const config = options.config || readJson(path.join(__dirname, "config.json"));
  const definitionsDirectory = options.definitionsDirectory || path.join(__dirname, "definitions");
  return new Fabricator(definitionsDirectory, config).generate(root ?? config.root);
}

function clearOutputDirectory(outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const filename of fs.readdirSync(outputDirectory)) {
    fs.rmSync(path.join(outputDirectory, filename), { recursive: true, force: true });
  }
}

function writeDocument(document, outputDirectory, count) {
  const filename = `tree-${String(count).padStart(12, "0")}.json`;
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  fs.writeFileSync(path.join(outputDirectory, filename), contents);
  return Buffer.byteLength(contents);
}

function writeDocuments(documents, outputDirectory = path.join(__dirname, "generated"), { onProgress, clearOutput = true } = {}) {
  if (clearOutput) clearOutputDirectory(outputDirectory);

  let count = 0;
  let bytes = 0;
  if (onProgress) onProgress({ count, bytes });
  for (const document of documents) {
    count += 1;
    bytes += writeDocument(document, outputDirectory, count);
    if (onProgress) onProgress({ count, bytes });
  }
  return count;
}

async function writeDocumentsLive(documents, outputDirectory, { onProgress, clearOutput = true } = {}) {
  if (clearOutput) clearOutputDirectory(outputDirectory);

  let count = 0;
  let bytes = 0;
  if (onProgress) onProgress({ count, bytes });
  for (const document of documents) {
    count += 1;
    bytes += writeDocument(document, outputDirectory, count);
    if (onProgress) onProgress({ count, bytes });
    if (count % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return count;
}

function generateToDirectory(options = {}) {
  const config = options.config || readJson(path.join(__dirname, "config.json"));
  const definitionsDirectory = options.definitionsDirectory || path.join(__dirname, "definitions");
  const fabricator = new Fabricator(definitionsDirectory, config);
  const outputDirectory = options.outputDirectory || path.join(__dirname, "generated");
  return writeDocuments(fabricator.generateTrees(options.root ?? config.root), outputDirectory);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

module.exports = {
  Fabricator,
  formatBytes,
  generate,
  generateToDirectory,
  writeDocuments,
  writeDocumentsLive,
};

if (require.main === module) {
  require("./cli").runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
