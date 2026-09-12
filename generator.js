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
  constructor(definitionsDirectory, { maxDepth, maxArrayLength }) {
    if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error("maxDepth must be a positive integer.");
    if (!Number.isInteger(maxArrayLength) || maxArrayLength < 0) throw new Error("maxArrayLength must be a non-negative integer.");

    this.maxDepth = maxDepth;
    this.maxArrayLength = maxArrayLength;
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

  *expand(value, depth, resolvingUnions = new Set()) {
    const parsed = parseDefinition(value);
    if (parsed.type === "literal") {
      yield parsed.value;
      return;
    }
    if (parsed.type === "array") {
      yield* this.expandArray(parsed.item, depth, resolvingUnions);
      return;
    }
    if (parsed.type === "tuple") {
      yield* this.expandTuple(parsed.values, depth, resolvingUnions);
      return;
    }
    if (parsed.type === "object") {
      yield* this.expandObject(this.normalizeEntries(parsed.entries, "Nested object"), depth, resolvingUnions);
      return;
    }

    const { kind, name, token } = parsed;
    switch (kind) {
      case "String": yield ""; return;
      case "Number": yield 0; return;
      case "Boolean": yield false; return;
      case "Null": yield null; return;
      case "function": {
        const reference = parseFunctionReference(name, token);
        yield deferredFunction(reference.functionName, reference.argumentPaths);
        return;
      }
      case "enum": {
        const enumName = requiredTokenName(kind, name, token);
        const values = this.definitionValues(this.enums, "Enum", enumName);
        yield* unique(values);
        return;
      }
      case "union": {
        const unionName = requiredTokenName(kind, name, token);
        const members = this.definitionValues(this.unions, "Union", unionName);
        if (resolvingUnions.has(unionName)) throw new Error(`Circular union: ${unionName}`);
        const next = new Set(resolvingUnions).add(unionName);
        for (const member of unique(members)) yield* this.expand(member, depth, next);
        return;
      }
      case "class": yield* this.expandClass(requiredTokenName(kind, name, token), depth + 1, resolvingUnions); return;
      default: throw new Error(`Unknown type token: ${token}`);
    }
  }

  definitionValues(definitions, type, name) {
    if (!definitions.has(name)) throw new Error(`Unknown ${type.toLowerCase()}: ${name}`);
    const values = definitions.get(name);
    if (!Array.isArray(values)) throw new Error(`${type} ${name} must contain a JSON array.`);
    return values;
  }

  *expandArray(itemDefinition, depth, resolvingUnions) {
    for (let length = 0; length <= this.maxArrayLength; length += 1) {
      yield* this.expandArrayItems(itemDefinition, length, depth, resolvingUnions);
    }
  }

  *expandArrayItems(itemDefinition, length, depth, resolvingUnions) {
    if (length === 0) {
      yield [];
      return;
    }
    for (const item of this.expand(itemDefinition, depth, resolvingUnions)) {
      for (const rest of this.expandArrayItems(itemDefinition, length - 1, depth, resolvingUnions)) yield [item, ...rest];
    }
  }

  *expandTuple(values, depth, resolvingUnions, index = 0, result = []) {
    if (index === values.length) {
      yield result;
      return;
    }
    for (const value of this.expand(values[index], depth, resolvingUnions)) {
      yield* this.expandTuple(values, depth, resolvingUnions, index + 1, [...result, value]);
    }
  }

  *expandObject(entries, depth, resolvingUnions, index = 0, result = {}) {
    if (index === entries.length) {
      yield result;
      return;
    }
    const { key, definition, optional } = entries[index];
    if (optional) yield* this.expandObject(entries, depth, resolvingUnions, index + 1, result);
    for (const value of this.expand(definition, depth, resolvingUnions)) {
      yield* this.expandObject(entries, depth, resolvingUnions, index + 1, { ...result, [key]: value });
    }
  }

  *expandClass(className, depth, resolvingUnions) {
    if (depth > this.maxDepth) {
      yield null;
      return;
    }
    yield* this.expandClassEntries(className, this.classEntries(className), 0, {}, depth, resolvingUnions);
  }

  *expandClassEntries(className, entries, index, object, depth, resolvingUnions) {
    if (index === entries.length) {
      this.classInstanceNames.set(object, className);
      yield object;
      return;
    }
    const entry = entries[index];
    if (entry.optional) yield* this.expandClassEntries(className, entries, index + 1, object, depth, resolvingUnions);
    for (const value of this.expand(entry.definition, depth, resolvingUnions)) {
      yield* this.expandClassEntries(className, entries, index + 1, { ...object, [entry.key]: value }, depth, resolvingUnions);
    }
  }

  buildPossibilityTree(value, depth = 0, resolvingUnions = new Set()) {
    const leaf = (type, details = {}) => ({ type, possibilities: 1n, ...details });
    const parsed = parseDefinition(value);
    if (parsed.type === "literal") return leaf("literal", { value: parsed.value });
    if (parsed.type === "array") return this.buildArrayPossibilityTree(parsed.item, depth, resolvingUnions);
    if (parsed.type === "tuple") return this.buildTuplePossibilityTree(parsed.values, depth, resolvingUnions);
    if (parsed.type === "object") return this.buildObjectPossibilityTree(this.normalizeEntries(parsed.entries, "Nested object"), depth, resolvingUnions);

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
        if (resolvingUnions.has(unionName)) throw new Error(`Circular union: ${unionName}`);
        const next = new Set(resolvingUnions).add(unionName);
        const children = unique(this.definitionValues(this.unions, "Union", unionName))
          .map((member) => this.buildPossibilityTree(member, depth, next));
        return { type: "union", name: unionName, possibilities: children.reduce((total, child) => total + child.possibilities, 0n), children };
      }
      case "class": return this.buildClassPossibilityTree(requiredTokenName(kind, name, token), depth + 1, resolvingUnions);
      default: throw new Error(`Unknown type token: ${token}`);
    }
  }

  buildArrayPossibilityTree(itemDefinition, depth, resolvingUnions) {
    const item = this.buildPossibilityTree(itemDefinition, depth, resolvingUnions);
    const lengths = [];
    let possibilities = 0n;
    for (let length = 0; length <= this.maxArrayLength; length += 1) {
      const count = item.possibilities ** BigInt(length);
      lengths.push({ length, possibilities: count });
      possibilities += count;
    }
    return { type: "array", possibilities, item, lengths };
  }

  buildTuplePossibilityTree(values, depth, resolvingUnions) {
    const children = values.map((value) => this.buildPossibilityTree(value, depth, resolvingUnions));
    return {
      type: "tuple",
      possibilities: children.reduce((total, child) => total * child.possibilities, 1n),
      children,
    };
  }

  buildObjectPossibilityTree(entries, depth, resolvingUnions) {
    const properties = entries.map(({ key, definition, optional }) => {
      const choices = this.buildPossibilityTree(definition, depth, resolvingUnions);
      return { name: key, optional, choices, possibilities: choices.possibilities + (optional ? 1n : 0n) };
    });
    return {
      type: "object",
      possibilities: properties.reduce((total, property) => total * property.possibilities, 1n),
      properties,
    };
  }

  buildClassPossibilityTree(className, depth, resolvingUnions) {
    if (depth > this.maxDepth) return { type: "class", name: className, truncated: true, possibilities: 1n, properties: [] };
    const properties = this.classEntries(className).map(({ key, definition, optional }) => {
      const choices = this.buildPossibilityTree(definition, depth, resolvingUnions);
      return { name: key, optional, possibilities: choices.possibilities + (optional ? 1n : 0n), choices };
    });
    return { type: "class", name: className, possibilities: properties.reduce((total, property) => total * property.possibilities, 1n), properties };
  }

  generate(root) {
    return Array.from(this.generateTrees(root));
  }

  *generateTrees(root) {
    for (const tree of this.expand(root, 0)) yield this.materialize(tree);
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

function writeDocuments(documents, outputDirectory = path.join(__dirname, "generated"), { onProgress } = {}) {
  clearOutputDirectory(outputDirectory);

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

async function writeDocumentsLive(documents, outputDirectory, { onProgress } = {}) {
  clearOutputDirectory(outputDirectory);

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

function createSpinner(label, stream = process.stdout) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let detail = "";
  let frame = 0;
  let timer;

  const render = (complete) => {
    const suffix = complete === undefined ? frames[frame++ % frames.length] : (complete ? "✓" : "✖");
    const line = `${suffix} ${label}:${detail ? ` ${detail}` : ""}`;
    if (stream.isTTY) stream.write(`\r\x1b[2K${line}`);
    else stream.write(`${line}\n`);
  };

  return {
    start() {
      render();
      timer = setInterval(render, stream.isTTY ? 80 : 500);
    },
    update(nextDetail) {
      detail = nextDetail;
    },
    stop(success = true) {
      if (timer) clearInterval(timer);
      render(success);
    },
  };
}

async function runCli() {
  const config = readJson(path.join(__dirname, "config.json"));
  const definitionsDirectory = path.join(__dirname, "definitions");
  const outputDirectory = path.join(__dirname, "generated");

  const loading = createSpinner("Loading definitions");
  loading.start();
  let fabricator;
  try {
    fabricator = new Fabricator(definitionsDirectory, config);
    loading.stop();
  } catch (error) {
    loading.stop(false);
    throw error;
  }

  const planning = createSpinner("Planning possibilities");
  planning.start();
  let tree;
  try {
    tree = fabricator.buildPossibilityTree(config.root);
    planning.stop();
  } catch (error) {
    planning.stop(false);
    throw error;
  }
  console.log(`Total possible documents: ${tree.possibilities}`);

  const generating = createSpinner("Generating documents");
  generating.start();
  try {
    const count = await writeDocumentsLive(fabricator.generateTrees(config.root), outputDirectory, {
      onProgress: ({ count: completed, bytes }) => generating.update(`${completed}  ${formatBytes(bytes)}`),
    });
    generating.stop();
    console.log(`Generated ${count} document(s) in ${outputDirectory}.`);
  } catch (error) {
    generating.stop(false);
    throw error;
  }
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { Fabricator, createSpinner, formatBytes, generate, generateToDirectory, writeDocuments, writeDocumentsLive };
