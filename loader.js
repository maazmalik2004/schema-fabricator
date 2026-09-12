const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`Could not read JSON file ${filename}: ${error.message}`);
  }
}

function filesIn(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return filesIn(filename, suffix);
      return entry.isFile() && entry.name.endsWith(suffix) ? [filename] : [];
    });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableDefinitions(definitions) {
  return deepFreeze(Object.fromEntries(
    [...definitions].map(([name, definition]) => [name, structuredClone(definition)])
  ));
}

class DefinitionLoader {
  constructor(definitionsDirectory) {
    this.definitionsDirectory = definitionsDirectory;
    this.functionCache = new Map();
  }

  load() {
    const classes = this.loadClasses();
    const enums = this.loadDefinitions("enums", ".enum.json");
    const unions = this.loadDefinitions("unions", ".union.json");
    const state = Object.fromEntries(this.loadDefinitions("state", ".state.json"));
    return {
      classes,
      enums,
      unions,
      state,
      schemaDefinitions: {
        enum: immutableDefinitions(enums),
        union: immutableDefinitions(unions),
      },
    };
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

  loadFunction(functionName) {
    if (this.functionCache.has(functionName)) return this.functionCache.get(functionName);
    const filename = path.join(this.definitionsDirectory, "functions", `${functionName}.function.js`);
    let source;
    try {
      source = fs.readFileSync(filename, "utf8");
    } catch (error) {
      throw new Error(`Could not load function ${functionName}: ${error.message}`);
    }
    try {
      const normalized = source
        .replace(/import\s+{([^}]+)}\s+from\s+["']([^"']+)["'];?/g, (_, names, moduleName) => {
          const bindings = names.split(",").map((name) => name.trim().replace(/\s+as\s+/g, ": ")).join(", ");
          return `const { ${bindings} } = require(${JSON.stringify(moduleName)});`;
        })
        .replace(/import\s+\*\s+as\s+(\w+)\s+from\s+["']([^"']+)["'];?/g, "const $1 = require('$2');")
        .replace(/import\s+(\w+)\s+from\s+["']([^"']+)["'];?/g, "const $1 = require('$2');")
        .replace(/export\s+(?=(async\s+)?function|const|let|var|class)/g, "");
      const factory = new Function(
        "schema",
        "require",
        `${normalized}\nreturn typeof ${functionName} === 'function' ? ${functionName} : undefined;`
      );
      const createImplementation = (schema) => factory(schema, createRequire(filename));
      this.functionCache.set(functionName, createImplementation);
      return createImplementation;
    } catch (error) {
      throw new Error(`Could not load function ${functionName}: ${error.message}`);
    }
  }
}

module.exports = { DefinitionLoader, readJson };
