const DEFERRED_FUNCTION = Symbol("function value to materialize");
const DEFERRED_FUNCTION_ARGUMENTS = Symbol("function argument paths");

function propertyName(rawKey) {
  return rawKey.endsWith("?") ? rawKey.slice(0, -1) : rawKey;
}

function requiredTokenName(kind, name, token) {
  if (!name) throw new Error(`${kind} token must include a name: ${token}`);
  return name;
}

function parseDefinition(value) {
  if (Array.isArray(value)) {
    if (value.length === 1) return { type: "array", item: value[0] };
    return { type: "tuple", values: value };
  }
  if (value && typeof value === "object") return { type: "object", entries: Object.entries(value) };
  if (typeof value !== "string") return { type: "literal", value };

  const arrayNotation = value.match(/^\[\s*(.*?)\s*\]$/);
  if (arrayNotation) {
    if (!arrayNotation[1]) throw new Error("Array notation must include an item type.");
    return { type: "array", item: arrayNotation[1] };
  }

  const token = value.match(/^<([A-Za-z]+)(?::([^>]+))?>$/);
  if (!token) return { type: "literal", value };
  const [, kind, name] = token;
  return { type: "token", kind, name, token: value };
}

function parseFunctionReference(name, token) {
  const [functionName, ...argumentPaths] = requiredTokenName("function", name, token).trim().split(/\s+/);
  if (argumentPaths.some((argumentPath) => !/^schema\.(class|enum|union)\.[A-Za-z][A-Za-z0-9_-]*$/.test(argumentPath))) {
    throw new Error(`Invalid function argument: ${token}`);
  }
  return { functionName, argumentPaths };
}

function deferredFunction(name, argumentPaths = []) {
  return { [DEFERRED_FUNCTION]: name, [DEFERRED_FUNCTION_ARGUMENTS]: argumentPaths };
}

function deferredFunctionName(value) {
  return value?.[DEFERRED_FUNCTION];
}

function deferredFunctionArguments(value) {
  return value?.[DEFERRED_FUNCTION_ARGUMENTS] || [];
}

function isDeferredFunction(value) {
  return deferredFunctionName(value) !== undefined;
}

function structuralKey(value) {
  if (isDeferredFunction(value)) return `<function:${[deferredFunctionName(value), ...deferredFunctionArguments(value)].join(" ")}>`;
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

module.exports = {
  deferredFunction,
  deferredFunctionArguments,
  deferredFunctionName,
  isDeferredFunction,
  parseDefinition,
  parseFunctionReference,
  propertyName,
  requiredTokenName,
  unique,
};
