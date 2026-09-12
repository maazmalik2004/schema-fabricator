const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { Worker, isMainThread, parentPort, threadId, workerData } = require("worker_threads");

const DEFERRED_FUNCTION = Symbol("function value to materialize");
const DISK_CLASS = "__schemaFabricatorClass";
const DISK_FUNCTION = "__schemaFabricatorFunction";
const DISK_VALUE = "__schemaFabricatorValue";

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`Could not read JSON file ${filename}: ${error.message}`);
  }
}

let atomicWriteSequence = 0;

function writeFileAtomically(filename, contents) {
  const temporary = `${filename}.${process.pid}.${threadId}.${atomicWriteSequence++}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, filename);
}

function writeJsonAtomically(filename, value) {
  writeFileAtomically(filename, JSON.stringify(value));
}

function filesIn(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return filesIn(filename, suffix);
      return entry.isFile() && entry.name.endsWith(suffix) ? [filename] : [];
    });
}

function structuralKey(value) {
  if (isDeferredFunction(value)) return `<function:${deferredFunctionName(value)}>`;
  if (Array.isArray(value)) return `[${value.map(structuralKey).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${structuralKey(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = structuralKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function propertyName(rawKey) {
  return rawKey.endsWith("?") ? rawKey.slice(0, -1) : rawKey;
}

function requiredTokenName(kind, name, token) {
  if (!name) throw new Error(`${kind} token must include a name: ${token}`);
  return name;
}

function isDeferredFunction(value) {
  return deferredFunctionName(value) !== undefined;
}

function deferredFunctionName(value) {
  if (!value) return undefined;
  if (value[DEFERRED_FUNCTION]) return value[DEFERRED_FUNCTION];
  if (value[DISK_FUNCTION] && Object.keys(value).length === 1) return value[DISK_FUNCTION];
  return undefined;
}

function diskClassName(value) {
  if (!value || typeof value !== "object") return undefined;
  if (!value[DISK_CLASS] || !Object.hasOwn(value, DISK_VALUE)) return undefined;
  return value[DISK_CLASS];
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nestedValue of Object.values(value)) deepFreeze(nestedValue);
  return Object.freeze(value);
}

function immutableDefinitions(definitions) {
  return deepFreeze(Object.fromEntries(
    [...definitions].map(([name, definition]) => [name, structuredClone(definition)])
  ));
}

class Fabricator {
  constructor(definitionsDirectory, {
    maxDepth,
    maxArrayLength,
    prunePossibility = 0,
    cleanUpStackAfterGeneration = true,
  }) {
    if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error("maxDepth must be a positive integer.");
    if (!Number.isInteger(maxArrayLength) || maxArrayLength < 0) throw new Error("maxArrayLength must be a non-negative integer.");
    if (typeof prunePossibility !== "number" || !Number.isFinite(prunePossibility)
      || prunePossibility < 0 || prunePossibility > 1) {
      throw new Error("prunePossibility must be a number between 0 and 1.");
    }
    if (typeof cleanUpStackAfterGeneration !== "boolean") {
      throw new Error("cleanUpStackAfterGeneration must be a boolean.");
    }
    this.definitionsDirectory = definitionsDirectory;
    this.maxDepth = maxDepth;
    this.maxArrayLength = maxArrayLength;
    this.prunePossibility = prunePossibility;
    this.cleanUpStackAfterGeneration = cleanUpStackAfterGeneration;
    this.classes = this.loadClasses();
    this.enums = this.loadDefinitions("enums", ".enum.json");
    this.unions = this.loadDefinitions("unions", ".union.json");
    this.schemaDefinitions = {
      enum: immutableDefinitions(this.enums),
      union: immutableDefinitions(this.unions),
    };
    this.functionCache = new Map();
    this.classHierarchyCache = new Map();
    this.classPropertiesCache = new Map();
    this.classInstanceNames = new WeakMap();
  }

  loadDefinitions(directory, suffix) {
    const definitions = new Map();
    for (const filename of filesIn(path.join(this.definitionsDirectory, directory), suffix)) {
      const name = path.basename(filename, suffix);
      if (definitions.has(name)) throw new Error(`Duplicate definition: ${name}`);
      definitions.set(name, readJson(filename));
    }
    return definitions;
  }

  loadClasses() {
    const records = filesIn(path.join(this.definitionsDirectory, "classes"), ".class.json").map((filename) => ({
      filename,
      name: path.basename(filename, ".class.json"),
      properties: readJson(filename),
    }));
    const byFilename = new Map(records.map((record) => [record.filename, record]));
    const byName = new Map();
    for (const record of records) {
      if (byName.has(record.name)) throw new Error(`Duplicate class name: ${record.name}`);
      byName.set(record.name, record);
      const directory = path.dirname(record.filename);
      if (path.basename(directory).endsWith(".class")) {
        const parentFilename = path.join(path.dirname(directory), `${path.basename(directory)}.json`);
        record.parent = byFilename.get(parentFilename);
        if (!record.parent) throw new Error(`Class ${record.name} has no matching parent definition.`);
      }
    }
    return byName;
  }

  classProperties(className, visited = new Set()) {
    if (this.classPropertiesCache.has(className)) return this.classPropertiesCache.get(className);
    const record = this.classes.get(className);
    if (!record) throw new Error(`Unknown class: ${className}`);
    if (visited.has(record.filename)) throw new Error(`Circular class inheritance involving ${className}`);
    if (!record.properties || Array.isArray(record.properties) || typeof record.properties !== "object") {
      throw new Error(`Class ${className} must contain a JSON object.`);
    }
    const ownPropertyNames = new Set();
    for (const rawKey of Object.keys(record.properties)) {
      const key = propertyName(rawKey);
      if (!key) throw new Error(`Class ${className} has an empty property name.`);
      if (ownPropertyNames.has(key)) {
        throw new Error(`Class ${className} defines ${key} more than once (including optional variants).`);
      }
      ownPropertyNames.add(key);
    }
    const ancestors = record.parent
      ? this.classProperties(record.parent.name, new Set(visited).add(record.filename))
      : {};
    const properties = { ...ancestors };
    for (const [rawKey, definition] of Object.entries(record.properties)) {
      const key = propertyName(rawKey);
      // `label` and `label?` describe the same property for override purposes.
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

  loadFunction(functionName) {
    if (this.functionCache.has(functionName)) return this.functionCache.get(functionName);
    const filename = path.join(this.definitionsDirectory, "functions", `${functionName}.function.js`);
    if (!fs.existsSync(filename)) throw new Error(`Unknown function: ${functionName}`);

    // Function definitions may use simple ESM imports although this file is CommonJS.
    let source = fs.readFileSync(filename, "utf8");
    source = source
      .replace(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?/g, (_match, names, moduleName) => {
        const bindings = names.split(",").map((name) => name.trim().replace(/\s+as\s+/g, ": ")).join(", ");
        return `const { ${bindings} } = require(${JSON.stringify(moduleName)});`;
      })
      .replace(/import\s+\*\s+as\s+(\w+)\s+from\s+["']([^"']+)["'];?/g, "const $1 = require('$2');")
      .replace(/import\s+(\w+)\s+from\s+["']([^"']+)["'];?/g, "const $1 = require('$2');")
      .replace(/export\s+(?=(async\s+)?function|const|let|var|class)/g, "");

    let createImplementation;
    try {
      const loadImplementation = new Function(
        "require",
        "schema",
        `${source}\nreturn typeof ${functionName} === "function" ? ${functionName} : undefined;`
      );
      const moduleRequire = createRequire(filename);
      createImplementation = (schema) => loadImplementation(moduleRequire, schema);
    } catch (error) {
      throw new Error(`Could not load function ${functionName}: ${error.message}`);
    }
    this.functionCache.set(functionName, createImplementation);
    return createImplementation;
  }

  *expand(value, depth, resolvingUnions = new Set()) {
    if (Array.isArray(value)) {
      if (value.length !== 1) throw new Error("Array notation must contain exactly one item type.");
      yield* this.expandArray(value[0], depth, resolvingUnions);
      return;
    }
    if (typeof value !== "string") {
      yield value;
      return;
    }
    const arrayNotation = value.match(/^\[\s*(.*?)\s*\]$/);
    if (arrayNotation) {
      if (!arrayNotation[1]) throw new Error("Array notation must include an item type.");
      yield* this.expandArray(arrayNotation[1], depth, resolvingUnions);
      return;
    }
    const token = value.match(/^<([A-Za-z]+)(?::([^>]+))?>$/);
    if (!token) {
      yield value;
      return;
    }
    const [, kind, name] = token;
    switch (kind) {
      case "String":
        yield "";
        return;
      case "Number":
        yield 0;
        return;
      case "Boolean":
        yield false;
        return;
      case "Null":
        yield null;
        return;
      // Functions are materialized after structural expansion so each JSON
      // occurrence still gets a fresh value.
      case "function":
        yield { [DEFERRED_FUNCTION]: requiredTokenName(kind, name, value) };
        return;
      case "enum": {
        const enumName = requiredTokenName(kind, name, value);
        if (!this.enums.has(enumName)) throw new Error(`Unknown enum: ${enumName}`);
        const values = this.enums.get(enumName);
        if (!Array.isArray(values)) throw new Error(`Enum ${enumName} must contain a JSON array.`);
        yield* unique(values);
        return;
      }
      case "union": {
        const unionName = requiredTokenName(kind, name, value);
        if (!this.unions.has(unionName)) throw new Error(`Unknown union: ${unionName}`);
        const members = this.unions.get(unionName);
        if (!Array.isArray(members)) throw new Error(`Union ${unionName} must contain a JSON array.`);
        if (resolvingUnions.has(unionName)) throw new Error(`Circular union: ${unionName}`);
        const next = new Set(resolvingUnions).add(unionName);
        for (const member of unique(members)) yield* this.expand(member, depth, next);
        return;
      }
      case "class":
        yield* this.expandClass(requiredTokenName(kind, name, value), depth + 1, resolvingUnions);
        return;
      default:
        throw new Error(`Unknown type token: ${value}`);
    }
  }

  *expandArray(itemDefinition, depth, resolvingUnions) {
    yield [];
    for (let length = 1; length <= this.maxArrayLength; length += 1) {
      yield* this.expandArrayItems(itemDefinition, length, depth, resolvingUnions);
    }
  }

  *expandArrayItems(itemDefinition, length, depth, resolvingUnions) {
    if (length === 0) {
      yield [];
      return;
    }
    for (const item of this.expand(itemDefinition, depth, resolvingUnions)) {
      for (const rest of this.expandArrayItems(itemDefinition, length - 1, depth, resolvingUnions)) {
        yield [item, ...rest];
      }
    }
  }

  *expandClass(className, depth, resolvingUnions) {
    // A truncated recursive branch remains valid JSON and cannot exceed maxDepth.
    if (depth > this.maxDepth) {
      yield null;
      return;
    }
    // A pruning probability of one lets us stop before expanding any branch.
    if (this.prunePossibility === 1) return;
    const entries = Object.entries(this.classProperties(className)).map(([rawKey, definition]) => ({
      key: propertyName(rawKey),
      definition,
      optional: rawKey.endsWith("?"),
    }));
    yield* this.expandClassEntries(className, entries, 0, {}, depth, resolvingUnions);
  }

  *expandClassEntries(className, entries, index, object, depth, resolvingUnions) {
    if (index === entries.length) {
      // Prune the candidate before it reaches a parent or document writing.
      if (!this.shouldPrune()) {
        this.classInstanceNames.set(object, className);
        yield object;
      }
      return;
    }

    const entry = entries[index];
    if (entry.optional) {
      yield* this.expandClassEntries(className, entries, index + 1, object, depth, resolvingUnions);
    }
    for (const value of this.expand(entry.definition, depth, resolvingUnions)) {
      yield* this.expandClassEntries(
        className,
        entries,
        index + 1,
        { ...object, [entry.key]: value },
        depth,
        resolvingUnions
      );
    }
  }

  shouldPrune() {
    return this.prunePossibility > 0 && Math.random() < this.prunePossibility;
  }

  // This pass describes branching without creating candidate objects or
  // running functions. BigInt keeps every multiplication exact.
  buildPossibilityTree(value, depth = 0, resolvingUnions = new Set()) {
    const leaf = (type, details = {}) => ({ type, possibilities: 1n, ...details });
    if (Array.isArray(value)) {
      if (value.length !== 1) throw new Error("Array notation must contain exactly one item type.");
      return this.buildArrayPossibilityTree(value[0], depth, resolvingUnions);
    }
    if (typeof value !== "string") return leaf("literal", { value });

    const arrayNotation = value.match(/^\[\s*(.*?)\s*\]$/);
    if (arrayNotation) {
      if (!arrayNotation[1]) throw new Error("Array notation must include an item type.");
      return this.buildArrayPossibilityTree(arrayNotation[1], depth, resolvingUnions);
    }
    const token = value.match(/^<([A-Za-z]+)(?::([^>]+))?>$/);
    if (!token) return leaf("literal", { value });

    const [, kind, name] = token;
    switch (kind) {
      case "String":
      case "Number":
      case "Boolean":
      case "Null":
        return leaf("primitive", { kind });
      case "function":
        return leaf("function", { name: requiredTokenName(kind, name, value) });
      case "enum": {
        const enumName = requiredTokenName(kind, name, value);
        if (!this.enums.has(enumName)) throw new Error(`Unknown enum: ${enumName}`);
        const values = this.enums.get(enumName);
        if (!Array.isArray(values)) throw new Error(`Enum ${enumName} must contain a JSON array.`);
        return { type: "enum", name: enumName, possibilities: BigInt(unique(values).length) };
      }
      case "union": {
        const unionName = requiredTokenName(kind, name, value);
        if (!this.unions.has(unionName)) throw new Error(`Unknown union: ${unionName}`);
        const members = this.unions.get(unionName);
        if (!Array.isArray(members)) throw new Error(`Union ${unionName} must contain a JSON array.`);
        if (resolvingUnions.has(unionName)) throw new Error(`Circular union: ${unionName}`);
        const next = new Set(resolvingUnions).add(unionName);
        const children = unique(members).map((member) => this.buildPossibilityTree(member, depth, next));
        return {
          type: "union",
          name: unionName,
          possibilities: children.reduce((total, child) => total + child.possibilities, 0n),
          children,
        };
      }
      case "class":
        return this.buildClassPossibilityTree(requiredTokenName(kind, name, value), depth + 1, resolvingUnions);
      default:
        throw new Error(`Unknown type token: ${value}`);
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

  buildClassPossibilityTree(className, depth, resolvingUnions) {
    // Match expandClass: a depth-limited class becomes one null.
    if (depth > this.maxDepth) {
      return { type: "class", name: className, truncated: true, possibilities: 1n, properties: [] };
    }
    const properties = Object.entries(this.classProperties(className)).map(([rawKey, definition]) => {
      const choices = this.buildPossibilityTree(definition, depth, resolvingUnions);
      return {
        name: propertyName(rawKey),
        optional: rawKey.endsWith("?"),
        possibilities: choices.possibilities + (rawKey.endsWith("?") ? 1n : 0n),
        choices,
      };
    });
    return {
      type: "class",
      name: className,
      possibilities: properties.reduce((total, property) => total * property.possibilities, 1n),
      properties,
    };
  }

  // Random pruning has no deterministic count. This remains exact when
  // pruning is disabled; otherwise callers can still use the structural tree.
  exactDocumentCount(root, possibilityTree = this.buildPossibilityTree(root)) {
    return this.prunePossibility === 0 ? possibilityTree.possibilities : undefined;
  }

  generate(root) {
    return Array.from(this.generateTrees(root));
  }

  *generateTrees(root) {
    // This remains lazy so command-line generation never retains the complete
    // expansion in memory. Class candidates are pruned in expandClassEntries.
    if (this.prunePossibility === 1) return;
    for (const tree of this.expand(root, 0)) yield this.materialize(tree);
  }

  *generateTreesFromDisk(root, stackDirectory, { resume = false } = {}) {
    if (this.prunePossibility === 1) return;
    yield* new DiskTreeExpander(this, stackDirectory).generate(root, { resume });
  }

  *generateTreesFromDiskStates(states, stackDirectory, { resume = false } = {}) {
    if (this.prunePossibility === 1) return;
    yield* new DiskTreeExpander(this, stackDirectory).generateStates(states, { resume });
  }

  createSchemaContext(classInstances) {
    return {
      class: Object.fromEntries(classInstances),
      enum: this.schemaDefinitions.enum,
      union: this.schemaDefinitions.union,
    };
  }

  materializeFunction(value, classInstances, schema = this.createSchemaContext(classInstances)) {
    const functionName = deferredFunctionName(value);
    const createImplementation = this.loadFunction(functionName);
    const implementation = createImplementation(schema);
    if (typeof implementation !== "function") {
      throw new Error(`Function file ${functionName}.function.js must define ${functionName}.`);
    }
    return implementation();
  }

  materialize(value, classInstances = new Map()) {
    if (isDeferredFunction(value)) return this.materializeFunction(value, classInstances);
    if (Array.isArray(value)) return value.map((item) => this.materialize(item, classInstances));
    if (value && typeof value === "object") {
      const instances = new Map(classInstances);
      const className = this.classInstanceNames.get(value) || diskClassName(value);
      const properties = diskClassName(value) ? value[DISK_VALUE] : value;
      const materialized = {};
      if (className) {
        for (const name of this.classHierarchy(className)) {
          instances.set(name, materialized);
        }
      }

      const deferred = [];
      for (const [key, item] of Object.entries(properties)) {
        if (isDeferredFunction(item)) {
          // Reserve the key so functions can run after their class's data is ready
          // without changing the JSON property order.
          materialized[key] = undefined;
          deferred.push([key, item]);
        } else {
          materialized[key] = this.materialize(item, instances);
        }
      }
      const schema = deferred.length ? this.createSchemaContext(instances) : undefined;
      for (const [key, item] of deferred) {
        materialized[key] = this.materializeFunction(item, instances, schema);
      }
      return materialized;
    }
    return value;
  }
}

function diskStateFilename(index) {
  return `state-${String(index).padStart(12, "0")}.json`;
}

function cloneState(state) {
  return structuredClone(state);
}

function setStateValue(state, pathSegments, value) {
  if (pathSegments.length === 0) {
    state.value = value;
    return;
  }
  let target = state.value;
  for (const segment of pathSegments.slice(0, -1)) target = target[segment];
  target[pathSegments.at(-1)] = value;
}

class DiskWorkStack {
  constructor(directory, { resume = false } = {}) {
    this.directory = directory;
    this.memory = [];
    this.diskCount = 0;
    if (resume) {
      fs.mkdirSync(directory, { recursive: true });
      this.recoverActiveState();
      this.diskCount = this.countSavedStates();
    } else {
      clearDirectory(directory);
    }
  }

  static hasCheckpoint(directory) {
    if (!fs.existsSync(directory)) return false;
    return fs.readdirSync(directory).some((filename) => /^state-\d+\.json$/.test(filename)
      || filename === "active-state.json");
  }

  countSavedStates() {
    const states = fs.readdirSync(this.directory)
      .filter((filename) => /^state-\d+\.json$/.test(filename))
      .sort();
    for (let index = 0; index < states.length; index += 1) {
      if (states[index] !== diskStateFilename(index)) {
        throw new Error(`Invalid expansion checkpoint in ${this.directory}.`);
      }
    }
    return states.length;
  }

  activeFilename() {
    return path.join(this.directory, "active-state.json");
  }

  recoverActiveState() {
    const active = this.activeFilename();
    if (!fs.existsSync(active)) return;
    try {
      readJson(active);
    } catch {
      // Older runs could be interrupted while writing this file. Its original
      // state is unavailable, but all already-persisted sibling states remain
      // safe to resume.
      fs.rmSync(active, { force: true });
      return;
    }
    const count = this.countSavedStates();
    fs.renameSync(active, path.join(this.directory, diskStateFilename(count)));
  }

  get isEmpty() {
    return this.memory.length === 0 && this.diskCount === 0;
  }

  push(state) {
    this.memory.push(state);
  }

  pop() {
    if (this.memory.length > 0) return this.memory.pop();
    if (this.diskCount === 0) return undefined;
    this.diskCount -= 1;
    const filename = path.join(this.directory, diskStateFilename(this.diskCount));
    fs.renameSync(filename, this.activeFilename());
    return readJson(this.activeFilename());
  }

  completeCall() {
    // Persist every completed expansion step before acknowledging its active
    // state, so a restart can recover a pending branch.
    this.flush();
    fs.rmSync(this.activeFilename(), { force: true });
  }

  flush() {
    for (const state of this.memory) {
      const filename = path.join(this.directory, diskStateFilename(this.diskCount));
      writeJsonAtomically(filename, state);
      this.diskCount += 1;
    }
    this.memory = [];
  }

  cleanup() {
    clearDirectory(this.directory);
  }
}

class DiskTreeExpander {
  constructor(fabricator, stackDirectory) {
    this.fabricator = fabricator;
    this.stackDirectory = stackDirectory;
  }

  *generate(root, { resume = false } = {}) {
    yield* this.generateStates([{
      value: null,
      tasks: [{ type: "expand", value: root, path: [], depth: 0, resolvingUnions: [] }],
    }], { resume });
  }

  *generateStates(states, { resume = false } = {}) {
    const work = new DiskWorkStack(this.stackDirectory, { resume });
    try {
      if (!resume) {
        for (const state of states) work.push(state);
        work.flush();
      }
      while (!work.isEmpty) {
        const state = work.pop();
        if (state.tasks.length === 0) {
          yield this.fabricator.materialize(state.value);
          work.completeCall();
          continue;
        }
        const task = state.tasks.pop();
        for (const nextState of this.expandTask(state, task)) {
          if (nextState.tasks.length === 0) yield this.fabricator.materialize(nextState.value);
          else work.push(nextState);
        }
        work.completeCall();
      }
    } finally {
      if (this.fabricator.cleanUpStackAfterGeneration) work.cleanup();
    }
  }

  expandTask(state, task) {
    if (task.type === "classEntries") return this.expandClassEntries(state, task);
    if (task.type === "completeClass") return this.completeClass(state);
    return this.expandValue(state, task);
  }

  expandValue(state, task) {
    const { value, path: valuePath, depth, resolvingUnions } = task;
    if (Array.isArray(value)) {
      if (value.length !== 1) throw new Error("Array notation must contain exactly one item type.");
      return this.expandArray(state, value[0], valuePath, depth, resolvingUnions);
    }
    if (typeof value !== "string") {
      setStateValue(state, valuePath, value);
      return [state];
    }
    const arrayNotation = value.match(/^\[\s*(.*?)\s*\]$/);
    if (arrayNotation) {
      if (!arrayNotation[1]) throw new Error("Array notation must include an item type.");
      return this.expandArray(state, arrayNotation[1], valuePath, depth, resolvingUnions);
    }
    const token = value.match(/^<([A-Za-z]+)(?::([^>]+))?>$/);
    if (!token) {
      setStateValue(state, valuePath, value);
      return [state];
    }
    const [, kind, name] = token;
    switch (kind) {
      case "String":
        setStateValue(state, valuePath, "");
        return [state];
      case "Number":
        setStateValue(state, valuePath, 0);
        return [state];
      case "Boolean":
        setStateValue(state, valuePath, false);
        return [state];
      case "Null":
        setStateValue(state, valuePath, null);
        return [state];
      case "function":
        setStateValue(state, valuePath, { [DISK_FUNCTION]: requiredTokenName(kind, name, value) });
        return [state];
      case "enum":
        return this.expandEnum(state, requiredTokenName(kind, name, value), valuePath);
      case "union":
        return this.expandUnion(state, requiredTokenName(kind, name, value), valuePath, depth, resolvingUnions);
      case "class":
        return this.expandClass(state, requiredTokenName(kind, name, value), valuePath, depth + 1, resolvingUnions);
      default:
        throw new Error(`Unknown type token: ${value}`);
    }
  }

  expandEnum(state, enumName, valuePath) {
    if (!this.fabricator.enums.has(enumName)) throw new Error(`Unknown enum: ${enumName}`);
    const values = this.fabricator.enums.get(enumName);
    if (!Array.isArray(values)) throw new Error(`Enum ${enumName} must contain a JSON array.`);
    return unique(values).map((value) => {
      const nextState = cloneState(state);
      setStateValue(nextState, valuePath, value);
      return nextState;
    });
  }

  expandUnion(state, unionName, valuePath, depth, resolvingUnions) {
    if (!this.fabricator.unions.has(unionName)) throw new Error(`Unknown union: ${unionName}`);
    const members = this.fabricator.unions.get(unionName);
    if (!Array.isArray(members)) throw new Error(`Union ${unionName} must contain a JSON array.`);
    if (resolvingUnions.includes(unionName)) throw new Error(`Circular union: ${unionName}`);
    return unique(members).map((member) => {
      const nextState = cloneState(state);
      nextState.tasks.push({
        type: "expand",
        value: member,
        path: valuePath,
        depth,
        resolvingUnions: [...resolvingUnions, unionName],
      });
      return nextState;
    });
  }

  expandArray(state, itemDefinition, valuePath, depth, resolvingUnions) {
    const states = [];
    for (let length = 0; length <= this.fabricator.maxArrayLength; length += 1) {
      const nextState = cloneState(state);
      setStateValue(nextState, valuePath, []);
      for (let index = length - 1; index >= 0; index -= 1) {
        nextState.tasks.push({
          type: "expand",
          value: itemDefinition,
          path: [...valuePath, index],
          depth,
          resolvingUnions,
        });
      }
      states.push(nextState);
    }
    return states;
  }

  expandClass(state, className, valuePath, depth, resolvingUnions) {
    if (depth > this.fabricator.maxDepth) {
      setStateValue(state, valuePath, null);
      return [state];
    }
    if (this.fabricator.prunePossibility === 1) return [];
    setStateValue(state, valuePath, { [DISK_CLASS]: className, [DISK_VALUE]: {} });
    state.tasks.push({
      type: "classEntries",
      className,
      classPath: valuePath,
      index: 0,
      depth,
      resolvingUnions,
    });
    return [state];
  }

  expandClassEntries(state, task) {
    const entries = Object.entries(this.fabricator.classProperties(task.className));
    if (task.index === entries.length) {
      state.tasks.push({ type: "completeClass" });
      return [state];
    }
    const [rawKey, definition] = entries[task.index];
    const nextEntry = { ...task, index: task.index + 1 };
    const expandProperty = {
      type: "expand",
      value: definition,
      path: [...task.classPath, DISK_VALUE, propertyName(rawKey)],
      depth: task.depth,
      resolvingUnions: task.resolvingUnions,
    };
    if (!rawKey.endsWith("?")) {
      state.tasks.push(nextEntry, expandProperty);
      return [state];
    }

    const omitted = state;
    omitted.tasks.push(nextEntry);
    const included = cloneState(state);
    included.tasks.push(nextEntry, expandProperty);
    return [omitted, included];
  }

  completeClass(state) {
    return this.fabricator.shouldPrune() ? [] : [state];
  }
}

function availableWorkerCount(config) {
  if (config.parallelism !== undefined
    && (!Number.isInteger(config.parallelism) || config.parallelism < 1)) {
    throw new Error("parallelism must be a positive integer.");
  }
  return config.parallelism || (os.availableParallelism ? os.availableParallelism() : os.cpus().length);
}

// Expand only until there are enough independent frontier states to distribute.
// The states retain the normal expander's tasks, so no documents or functions
// are created during this planning step.
function splitExpansionStates(fabricator, root, desiredCount) {
  const splitter = new DiskTreeExpander(fabricator, "");
  const states = [{
    value: null,
    tasks: [{ type: "expand", value: root, path: [], depth: 0, resolvingUnions: [] }],
  }];
  let cursor = 0;
  while (states.length < desiredCount) {
    let expanded = false;
    for (let attempt = 0; attempt < states.length; attempt += 1) {
      const index = cursor % states.length;
      cursor += 1;
      const state = states[index];
      if (state.tasks.length === 0) continue;
      // Pruning is intentionally left to the worker that owns this branch so
      // splitting never consumes random choices.
      if (state.tasks.at(-1).type === "completeClass") continue;
      const task = state.tasks.pop();
      const nextStates = splitter.expandTask(state, task);
      states.splice(index, 1, ...nextStates);
      expanded = true;
      break;
    }
    if (!expanded) break;
  }
  return states;
}

function generate(root, options = {}) {
  const config = options.config || readJson(path.join(__dirname, "config.json"));
  const definitionsDirectory = options.definitionsDirectory || path.join(__dirname, "definitions");
  return new Fabricator(definitionsDirectory, config).generate(root ?? config.root);
}

function clearDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const filename of fs.readdirSync(directory)) {
    fs.rmSync(path.join(directory, filename), { recursive: true, force: true });
  }
}

function existingDocumentCount(outputDirectory) {
  if (!fs.existsSync(outputDirectory)) return 0;
  const filenames = fs.readdirSync(outputDirectory)
    .filter((filename) => /^tree-\d+\.json$/.test(filename))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  for (let index = 0; index < filenames.length; index += 1) {
    const expected = `tree-${String(index + 1).padStart(4, "0")}.json`;
    if (filenames[index] !== expected) {
      throw new Error(`Cannot resume: generated documents are not sequential in ${outputDirectory}.`);
    }
  }
  return filenames.length;
}

function writeDocuments(documents, outputDirectory = path.join(__dirname, "generated"), {
  append = false,
  filenameForNext,
  startingCount,
  onProgress,
  total,
} = {}) {
  // A new generation owns this directory. A resumed generation instead keeps
  // its completed prefix and writes only the remaining documents.
  if (append) fs.mkdirSync(outputDirectory, { recursive: true });
  else clearDirectory(outputDirectory);
  const expectedTotal = total === undefined && Array.isArray(documents) ? documents.length : total;
  let count = startingCount === undefined ? (append ? existingDocumentCount(outputDirectory) : 0) : startingCount;
  if (onProgress && expectedTotal !== undefined) onProgress(count, expectedTotal);
  const iterator = documents[Symbol.iterator]();
  let next = iterator.next();
  try {
    while (!next.done) {
      const document = next.value;
      const filename = filenameForNext
        ? filenameForNext()
        : `tree-${String(count + 1).padStart(4, "0")}.json`;
      writeFileAtomically(path.join(outputDirectory, filename), `${JSON.stringify(document, null, 2)}\n`);
      count += 1;
      // Resume the expander immediately after the durable document write so it
      // can acknowledge and discard that completed state before progress code
      // (or a caller) has an opportunity to interrupt the run.
      next = iterator.next(true);
      if (onProgress) onProgress(count, expectedTotal);
    }
  } finally {
    if (!next.done && typeof iterator.return === "function") iterator.return();
  }
  return count;
}

function generateToDisk(documents, outputDirectory, stackDirectory, {
  cleanUpStackAfterGeneration = true,
  resume = false,
  prepare,
  total,
  onComplete,
  onProgress,
} = {}) {
  if (path.resolve(outputDirectory) === path.resolve(stackDirectory)) {
    throw new Error("outputDirectory and stackDirectory must be different directories.");
  }
  if (typeof cleanUpStackAfterGeneration !== "boolean") {
    throw new Error("cleanUpStackAfterGeneration must be a boolean.");
  }
  if (!resume) clearDirectory(stackDirectory);
  try {
    // The iterator is lazy, so this writes each document as its tree finishes
    // expanding instead of staging every document before generation begins.
    if (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) {
      throw new Error("total must be a non-negative safe integer when provided.");
    }
    if (prepare) prepare();
    const generated = writeDocuments(documents, outputDirectory, { append: resume, onProgress, total });
    if (onComplete) onComplete(generated);
    return generated;
  } finally {
    if (cleanUpStackAfterGeneration) clearDirectory(stackDirectory);
  }
}

function createProgressBar(stream = process.stdout) {
  const width = 30;
  return (current, total) => {
    if (!stream.isTTY) return;
    if (total === undefined) {
      stream.write(`\rGenerating documents: ${current}`);
      return;
    }
    const ratio = total === 0 ? 1 : Math.min(1, Math.max(0, current / total));
    const complete = Math.round(ratio * width);
    const bar = `${"█".repeat(complete)}${"▒".repeat(width - complete)}`;
    stream.write(`\rGenerating documents: ${bar} ${current}/${total}`);
    if (current === total) stream.write("\n");
  };
}

function createWorkerProgressDashboard(stream = process.stdout) {
  const workers = new Map();
  let expectedTotal;
  let renderedLines = 0;

  const render = () => {
    if (!stream.isTTY || workers.size === 0) return;
    const total = [...workers.values()].reduce((sum, worker) => Math.max(sum, worker.total), 0);
    const tally = expectedTotal === undefined ? total : `${total}/${expectedTotal}`;
    const lines = [...workers.entries()]
      .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
      .map(([id, worker]) => `Worker ${id}: ${worker.completed} document(s) ${worker.complete ? "complete" : "working"}`);
    lines.push(`Total tally: ${tally} document(s)`);

    if (renderedLines > 0) stream.write(`\x1b[${renderedLines}A`);
    for (const line of lines) stream.write(`\x1b[2K${line}\n`);
    renderedLines = lines.length;
  };

  return {
    setExpectedTotal(total) {
      expectedTotal = total;
    },
    update({ worker, completed, total, complete }) {
      workers.set(worker, { completed, total, complete });
      render();
    },
  };
}

function createSpinner(label = "Planning possibilities", stream = process.stdout) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  let timer;

  const render = () => stream.write(`\r${label} ${frames[frame++ % frames.length]}`);
  return {
    start() {
      if (!stream.isTTY) {
        stream.write(`${label}...\n`);
        return;
      }
      render();
      timer = setInterval(render, 80);
    },
    stop(success = true) {
      if (!stream.isTTY) return;
      clearInterval(timer);
      stream.write(`\r${label} ${success ? "✓" : "✖"}\n`);
    },
  };
}

function runSingleGenerationWorker() {
  const fabricator = new Fabricator(workerData.definitionsDirectory, workerData.config);
  const possibilityTree = fabricator.buildPossibilityTree(workerData.root);
  const exactTotal = fabricator.exactDocumentCount(workerData.root, possibilityTree);
  if (workerData.config.resume !== undefined && typeof workerData.config.resume !== "boolean") {
    throw new Error("resume must be a boolean.");
  }
  const expansionDirectory = path.join(workerData.stackDirectory, "expansion");
  const manifestFilename = path.join(workerData.stackDirectory, "generation.json");
  const manifest = JSON.stringify({
    version: 1,
    root: workerData.root,
    maxDepth: workerData.config.maxDepth,
    maxArrayLength: workerData.config.maxArrayLength,
    prunePossibility: workerData.config.prunePossibility,
    possibilities: possibilityTree.possibilities.toString(),
  });
  const resume = workerData.config.resume !== false && DiskWorkStack.hasCheckpoint(expansionDirectory);
  if (resume) {
    if (!fs.existsSync(manifestFilename) || fs.readFileSync(manifestFilename, "utf8") !== manifest) {
      throw new Error("The saved checkpoint does not match this generation plan. Remove stack/ to start over.");
    }
  }
  parentPort.postMessage({
    type: "planned",
    possibilities: possibilityTree.possibilities.toString(),
    total: exactTotal === undefined ? undefined : exactTotal.toString(),
    resume,
  });
  const progressTotal = exactTotal !== undefined && exactTotal <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(exactTotal)
    : undefined;
  const total = generateToDisk(
    fabricator.generateTreesFromDisk(workerData.root, expansionDirectory, { resume }),
    workerData.outputDirectory,
    workerData.stackDirectory,
    {
      cleanUpStackAfterGeneration: workerData.config.cleanUpStackAfterGeneration,
      resume,
      prepare: resume ? undefined : () => writeFileAtomically(manifestFilename, manifest),
      total: progressTotal,
      onProgress: (current, expectedTotal) => {
        if (current % 100 === 0) {
          parentPort.postMessage({ type: "progress", current, total: expectedTotal });
        }
      },
    }
  );
  parentPort.postMessage({ type: "complete", total });
}

function documentIndexCeiling(outputDirectory) {
  if (!fs.existsSync(outputDirectory)) return 0;
  return fs.readdirSync(outputDirectory).reduce((highest, filename) => {
    const match = filename.match(/^tree-(\d+)\.json$/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
}

function parallelManifest(root, config, possibilityTree, partitions) {
  return JSON.stringify({
    version: 3,
    root,
    maxDepth: config.maxDepth,
    maxArrayLength: config.maxArrayLength,
    prunePossibility: config.prunePossibility,
    possibilities: possibilityTree.possibilities.toString(),
    jobs: partitions,
  });
}

function runPartitionWorker() {
  const fabricator = new Fabricator(workerData.definitionsDirectory, workerData.config);
  const counter = new Int32Array(workerData.documentCounter);
  let completed = 0;

  parentPort.on("message", ({ action, job, jobDirectory, resume }) => {
    if (action !== "run-job") return;
    try {
      const expansionDirectory = path.join(jobDirectory, "expansion");
      const shouldResume = resume && DiskWorkStack.hasCheckpoint(expansionDirectory);
      const seeds = readJson(path.join(jobDirectory, "seed.json"));
      let reported = 0;
      const generated = writeDocuments(
        fabricator.generateTreesFromDiskStates(seeds, expansionDirectory, { resume: shouldResume }),
        workerData.outputDirectory,
        {
          append: true,
          startingCount: 0,
          filenameForNext: () => `tree-${String(Atomics.add(counter, 0, 1) + 1).padStart(4, "0")}.json`,
          onProgress: (current) => {
            if (current - reported >= 100) {
              reported = current;
              parentPort.postMessage({
                type: "worker-progress",
                worker: workerData.workerId,
                completed: completed + current,
                total: Atomics.load(counter, 0),
              });
            }
          },
        }
      );
      completed += generated;
      writeJsonAtomically(path.join(jobDirectory, "complete.json"), { generated });
      parentPort.postMessage({
        type: "job-complete",
        job,
        worker: workerData.workerId,
        completed,
        total: Atomics.load(counter, 0),
      });
    } catch (error) {
      parentPort.postMessage({ type: "job-error", job, error: error.message });
    }
  });
  parentPort.postMessage({ type: "worker-ready", worker: workerData.workerId });
}

function startPartitionPool(workerOptions, jobs, jobsDirectory, resume, workerCount) {
  return new Promise((resolve, reject) => {
    if (workerCount === 0) {
      resolve();
      return;
    }
    const pending = [...jobs];
    const workers = [];
    let stopping = false;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      stopping = true;
      Promise.all(workers.map(({ worker }) => worker.terminate())).finally(() => reject(error));
    };
    const finishIfIdle = () => {
      if (settled || pending.length > 0 || workers.some(({ job }) => job)) return;
      settled = true;
      stopping = true;
      for (const record of workers) {
        parentPort.postMessage({
          type: "worker-complete",
          worker: record.id,
          completed: record.completed,
          total: Atomics.load(new Int32Array(workerOptions.documentCounter), 0),
        });
      }
      Promise.all(workers.map(({ worker }) => worker.terminate())).then(() => resolve(), reject);
    };
    const assign = (record) => {
      const job = pending.shift();
      if (!job) {
        record.job = undefined;
        finishIfIdle();
        return;
      }
      record.job = job;
      record.worker.postMessage({
        action: "run-job",
        job,
        jobDirectory: path.join(jobsDirectory, job),
        resume,
      });
    };

    for (let index = 0; index < workerCount; index += 1) {
      const id = String(index + 1).padStart(4, "0");
      const worker = new Worker(__filename, { workerData: { ...workerOptions, workerId: id } });
      const record = { id, worker, job: undefined, completed: 0 };
      workers.push(record);
      worker.on("message", (message) => {
        if (message.type === "worker-ready") {
          parentPort.postMessage({
            type: "worker-progress",
            worker: record.id,
            completed: 0,
            total: Atomics.load(new Int32Array(workerOptions.documentCounter), 0),
          });
          assign(record);
        }
        if (message.type === "worker-progress") parentPort.postMessage(message);
        if (message.type === "job-complete") {
          record.completed = message.completed;
          record.job = undefined;
          parentPort.postMessage({ ...message, type: "worker-progress" });
          assign(record);
        }
        if (message.type === "job-error") fail(new Error(`Job ${message.job} failed: ${message.error}`));
      });
      worker.on("error", fail);
      worker.on("exit", (code) => {
        if (!stopping) fail(new Error(`Generation worker ${record.id} exited with code ${code}.`));
      });
    }
  });
}

async function runParallelGenerationWorker() {
  const fabricator = new Fabricator(workerData.definitionsDirectory, workerData.config);
  const possibilityTree = fabricator.buildPossibilityTree(workerData.root);
  const exactTotal = fabricator.exactDocumentCount(workerData.root, possibilityTree);
  const workerLimit = availableWorkerCount(workerData.config);
  const jobsDirectory = path.join(workerData.stackDirectory, "jobs");
  const manifestFilename = path.join(workerData.stackDirectory, "parallel-generation.json");
  const existingJobs = fs.existsSync(jobsDirectory)
    ? fs.readdirSync(jobsDirectory).filter((name) => /^job-\d+$/.test(name)).sort()
    : [];
  const incompleteJobs = existingJobs.filter(
    (name) => !fs.existsSync(path.join(jobsDirectory, name, "complete.json"))
  );
  const resume = workerData.config.resume !== false
    && fs.existsSync(manifestFilename)
    && incompleteJobs.length > 0;

  let jobs;
  if (resume) {
    const saved = JSON.parse(fs.readFileSync(manifestFilename, "utf8"));
    const expected = parallelManifest(workerData.root, workerData.config, possibilityTree, saved.jobs);
    if (fs.readFileSync(manifestFilename, "utf8") !== expected) {
      throw new Error("The saved parallel checkpoint does not match this generation plan. Remove stack/ to start over.");
    }
    jobs = saved.jobs;
  } else {
    const states = splitExpansionStates(fabricator, workerData.root, workerLimit * 4);
    jobs = states.length;
    clearDirectory(workerData.stackDirectory);
    clearDirectory(workerData.outputDirectory);
    fs.mkdirSync(jobsDirectory, { recursive: true });
    writeFileAtomically(manifestFilename, parallelManifest(workerData.root, workerData.config, possibilityTree, jobs));
    states.forEach((state, index) => {
      const directory = path.join(jobsDirectory, `job-${String(index + 1).padStart(4, "0")}`);
      fs.mkdirSync(directory, { recursive: true });
      writeJsonAtomically(path.join(directory, "seed.json"), [state]);
    });
  }

  const jobNames = resume ? incompleteJobs : fs.readdirSync(jobsDirectory)
    .filter((name) => /^job-\d+$/.test(name)).sort();
  const activeWorkers = Math.min(workerLimit, jobNames.length);

  parentPort.postMessage({
    type: "planned",
    possibilities: possibilityTree.possibilities.toString(),
    total: exactTotal === undefined ? undefined : exactTotal.toString(),
    resume,
    workers: activeWorkers,
    jobs,
  });
  const counterBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const counter = new Int32Array(counterBuffer);
  Atomics.store(counter, 0, documentIndexCeiling(workerData.outputDirectory));
  await startPartitionPool({
    action: "generate-partition",
    config: workerData.config,
    definitionsDirectory: workerData.definitionsDirectory,
    outputDirectory: workerData.outputDirectory,
    documentCounter: counterBuffer,
  }, jobNames, jobsDirectory, resume, activeWorkers);
  const total = Atomics.load(counter, 0);
  if (workerData.config.cleanUpStackAfterGeneration) clearDirectory(workerData.stackDirectory);
  parentPort.postMessage({ type: "complete", total });
}

async function runGenerationWorker() {
  if (workerData.config.parallelism !== 1 && availableWorkerCount(workerData.config) > 1) {
    await runParallelGenerationWorker();
  } else {
    runSingleGenerationWorker();
  }
}

function generateFromCli(config) {
  return new Promise((resolve, reject) => {
    const spinner = createSpinner();
    const progress = createProgressBar();
    const workerDashboard = createWorkerProgressDashboard();
    let spinnerRunning = true;
    let complete = false;
    let expectedTotal;
    const stopSpinner = (success) => {
      if (!spinnerRunning) return;
      spinnerRunning = false;
      spinner.stop(success);
    };
    const worker = new Worker(__filename, {
      workerData: {
        action: "generate-documents",
        config,
        root: config.root,
        definitionsDirectory: path.join(__dirname, "definitions"),
        outputDirectory: path.join(__dirname, "generated"),
        stackDirectory: path.join(__dirname, "stack"),
      },
    });

    spinner.start();
    worker.on("message", (message) => {
      if (message.type === "planned") {
        stopSpinner(true);
        expectedTotal = message.total;
        workerDashboard.setExpectedTotal(expectedTotal);
        if (message.total === undefined) {
          console.log(`Planned ${message.possibilities} possible tree(s) before random pruning.`);
        } else {
          console.log(`Planned ${message.possibilities} possible tree(s).`);
        }
        if (message.resume) console.log("Resuming from the saved checkpoint.");
        if (message.workers) console.log(`Using ${message.workers} parallel worker(s).`);
      }
      if (message.type === "progress") progress(message.current, message.total);
      if (message.type === "worker-progress" || message.type === "worker-complete") {
        workerDashboard.update({
          worker: message.worker,
          completed: message.completed,
          total: message.total,
          complete: message.type === "worker-complete",
        });
      }
      if (message.type === "complete") {
        progress(message.total, message.total);
        console.log(`Total tally: ${message.total} document(s).`);
        complete = true;
        resolve(message.total);
      }
    });
    worker.on("error", (error) => {
      stopSpinner(false);
      if (!complete) reject(error);
    });
    worker.on("exit", (code) => {
      if (code !== 0 && !complete) {
        stopSpinner(false);
        reject(new Error(`Generation worker exited with code ${code}.`));
      }
    });
  });
}

if (!isMainThread && workerData && workerData.action === "generate-partition") {
  runPartitionWorker();
} else if (!isMainThread && workerData && workerData.action === "generate-documents") {
  runGenerationWorker().catch((error) => {
    throw error;
  });
}

if (require.main === module && isMainThread) {
  const config = readJson(path.join(__dirname, "config.json"));
  generateFromCli(config)
    .then((total) => {
      console.log(`Generated ${total} document(s) in ${path.join(__dirname, "generated")}.`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = {
  Fabricator,
  clearDirectory,
  createProgressBar,
  createSpinner,
  generate,
  generateToDisk,
  writeDocuments,
};
