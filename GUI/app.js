import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { json, jsonLanguage } from "@codemirror/lang-json";
import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import { lintGutter, linter } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";

const editorHost = document.querySelector("#editor");
const formEditor = document.querySelector("#formEditor");
const editorModes = document.querySelector("#editorModes");
const fileTree = document.querySelector("#fileTree");
const fileName = document.querySelector("#fileName");
const status = document.querySelector("#status");
const dirty = document.querySelector("#dirty");
const suggestions = document.querySelector("#suggestions");
const dialog = document.querySelector("#createDialog");
const createForm = document.querySelector("#createForm");
const definitionType = document.querySelector("#definitionType");
const parentField = document.querySelector("#parentField");
const parentClass = document.querySelector("#parentClass");
const definitionName = document.querySelector("#definitionName");

let project = { files: [], classes: [], tokens: {} };
let currentPath = "";
let savedContent = "";
let editor;
let editorMode = "json";
let guiDocument;
const collapsedGroups = new Set();

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}

function content() { return editor ? editor.state.doc.toString() : ""; }
function replaceContent(value) {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
}
function setStatus(message, kind = "") { status.textContent = message; status.className = `status ${kind}`; }
function markDirty() { dirty.textContent = content() === savedContent ? "" : "Unsaved"; }
function groupFor(file) { return file === "config.json" ? "Project" : file.split("/")[1] || "Definitions"; }
function displayName(file) {
  return file.split("/").at(-1)
    .replace(/\.class\.json$/, "").replace(/\.enum\.json$/, "").replace(/\.union\.json$/, "")
    .replace(/\.function\.js$/, "").replace(/\.state\.json$/, "");
}

function renderTree() {
  const groups = new Map();
  for (const file of project.files) groups.set(groupFor(file), [...(groups.get(groupFor(file)) || []), file]);
  fileTree.replaceChildren(...[...groups].flatMap(([group, files]) => {
    const title = document.createElement("button");
    title.className = `file-group${collapsedGroups.has(group) ? " collapsed" : ""}`;
    title.textContent = group;
    title.onclick = () => { collapsedGroups.has(group) ? collapsedGroups.delete(group) : collapsedGroups.add(group); renderTree(); };
    if (collapsedGroups.has(group)) return [title];
    return [title, ...files.map((file) => {
      const button = document.createElement("button");
      button.className = `file${file === currentPath ? " active" : ""}${file.split("/").length > 3 ? " nested" : ""}`;
      button.textContent = displayName(file); button.title = file; button.onclick = () => openFile(file);
      return button;
    })];
  }));
}

function tokenCandidates() {
  return [
    { label: "<String>", type: "primitive" }, { label: "<Number>", type: "primitive" },
    { label: "<Boolean>", type: "primitive" }, { label: "<Null>", type: "primitive" },
    ...["class", "enum", "union", "function"].flatMap((kind) =>
      (project.tokens[kind] || []).map((name) => ({ label: `<${kind}:${name}>`, type: kind }))),
  ];
}

function schemaCompletions(context) {
  const match = context.matchBefore(/<[^<>\s]*/);
  if (!match || (match.from === match.to && !context.explicit)) return null;
  return { from: match.from, options: tokenCandidates() };
}

function syntaxLinter(parser) {
  return linter((view) => {
    const diagnostics = [];
    parser.parse(view.state.doc.toString()).iterate({
      enter(node) {
        if (node.type.isError) diagnostics.push({ from: node.from, to: Math.max(node.to, node.from + 1), severity: "error", message: "Syntax error" });
      },
    });
    return diagnostics;
  });
}

function isFunctionFile() { return currentPath.endsWith(".function.js"); }
function createEditor(value) {
  if (editor) editor.destroy();
  const javascriptMode = isFunctionFile();
  editor = new EditorView({
    state: EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), history(), indentOnInput(), bracketMatching(), closeBrackets(),
        highlightActiveLine(), lintGutter(), oneDark,
        javascriptMode ? javascript() : json(),
        syntaxLinter(javascriptMode ? javascriptLanguage.parser : jsonLanguage.parser),
        autocompletion({ override: [schemaCompletions], activateOnTyping: true }),
        keymap.of([
          ...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap, ...completionKeymap, indentWithTab,
          { key: "Mod-s", run: () => { save().catch((error) => setStatus(error.message, "error")); return true; } },
        ]),
        EditorView.updateListener.of((update) => { if (update.docChanged) markDirty(); }),
      ],
    }),
    parent: editorHost,
  });
}

function insert(text) {
  if (editorMode === "gui") setEditorMode("json");
  editor.dispatch(editor.state.replaceSelection(text));
  editor.focus(); markDirty();
}

const valueKinds = [
  ["string", "String"], ["number", "Number"], ["boolean", "Boolean"], ["null", "Null"],
  ["class", "Class reference"], ["enum", "Enum reference"], ["union", "Union reference"],
  ["function", "Function reference"], ["array", "Array"], ["tuple", "Tuple"], ["object", "Object"], ["literal", "Literal value"],
];

function optionSelect(options, selected) {
  const select = document.createElement("select");
  select.append(...options.map(([value, label]) => new Option(label, value, false, value === selected)));
  return select;
}

function valueDescription(value) {
  if (Array.isArray(value)) return { kind: value.length === 1 ? "array" : "tuple", value };
  if (value && typeof value === "object") return { kind: "object", value };
  if (typeof value === "string") {
    const arrayNotation = value.match(/^\[\s*(.*?)\s*\]$/);
    if (arrayNotation && arrayNotation[1]) return { kind: "array", value: [arrayNotation[1]], notation: true };
    const primitive = value.match(/^<(String|Number|Boolean|Null)>$/);
    if (primitive) return { kind: primitive[1].toLowerCase(), value };
    const reference = value.match(/^<(class|enum|union|function):([^>]+)>$/);
    if (reference) return { kind: reference[1], value, target: reference[2] };
  }
  return { kind: "literal", value };
}

function defaultValue(kind) {
  const first = (name, fallback) => (project.tokens[name] || [fallback])[0];
  return {
    string: "<String>", number: "<Number>", boolean: "<Boolean>", null: "<Null>",
    class: `<class:${first("class", "Name")}>`, enum: `<enum:${first("enum", "Name")}>`,
    union: `<union:${first("union", "Name")}>`, function: `<function:${first("function", "name")}>`,
    array: ["<String>"], tuple: [], object: {}, literal: "",
  }[kind];
}

function nestedLabel(text) {
  const label = document.createElement("p"); label.className = "nested-label"; label.textContent = text; return label;
}

function renderLiteral(value, apply) {
  const container = document.createElement("div"); container.className = "literal-value";
  const literalKind = value === null ? "null" : typeof value;
  const select = optionSelect([["string", "Text"], ["number", "Number"], ["boolean", "Boolean"], ["null", "Null"]], literalKind);
  const valueInput = document.createElement("input");
  if (literalKind === "boolean") {
    valueInput.replaceWith();
    const bool = optionSelect([["true", "true"], ["false", "false"]], String(value));
    bool.onchange = () => apply(bool.value === "true"); container.append(select, bool);
  } else if (literalKind === "null") {
    const note = document.createElement("span"); note.textContent = "No value"; note.style.color = "var(--muted)"; container.append(select, note);
  } else {
    valueInput.type = literalKind === "number" ? "number" : "text";
    valueInput.value = value ?? "";
    valueInput.oninput = () => apply(literalKind === "number" ? Number(valueInput.value) : valueInput.value);
    container.append(select, valueInput);
  }
  select.onchange = () => { apply(defaultValue(select.value)); renderGuiEditor(); };
  return container;
}

function renderValueEditor(value, apply, label = "") {
  const description = valueDescription(value);
  const wrapper = document.createElement("section"); wrapper.className = "value-editor";
  if (label) wrapper.append(nestedLabel(label));
  const controls = document.createElement("div"); controls.className = "value-controls";
  const typeLabel = document.createElement("label"); typeLabel.textContent = "Type";
  const kind = optionSelect(valueKinds, description.kind); typeLabel.append(kind); controls.append(typeLabel); wrapper.append(controls);
  kind.onchange = () => { apply(defaultValue(kind.value)); renderGuiEditor(); };

  if (["class", "enum", "union", "function"].includes(description.kind)) {
    const targetLabel = document.createElement("label"); targetLabel.textContent = description.kind === "function" ? "Function and arguments" : "Reference name";
    const target = document.createElement("input"); target.value = description.target; target.placeholder = description.kind === "function" ? "name schema.class.Article" : "Definition name";
    target.setAttribute("list", `known-${description.kind}s`);
    target.oninput = () => apply(`<${description.kind}:${target.value.trim()}>`);
    targetLabel.append(target); controls.append(targetLabel);
    const names = document.createElement("datalist"); names.id = `known-${description.kind}s`;
    const source = description.kind === "function" ? project.tokens.function : project.tokens[description.kind];
    names.append(...(source || []).map((name) => new Option(name))); wrapper.append(names);
  }

  if (description.kind === "literal") wrapper.append(renderLiteral(value, apply));
  if (description.kind === "array") {
    const nested = document.createElement("div"); nested.className = "nested-editor";
    nested.append(renderValueEditor(description.value[0], (next) => apply([next]), "Array item")); wrapper.append(nested);
  }
  if (description.kind === "tuple") {
    const nested = document.createElement("div"); nested.className = "nested-editor"; nested.append(nestedLabel("Tuple entries"));
    description.value.forEach((item, index) => {
      const itemWrapper = document.createElement("div"); itemWrapper.className = "nested-editor";
      itemWrapper.append(renderValueEditor(item, (next) => {
        const nextTuple = [...description.value]; nextTuple[index] = next; apply(nextTuple);
      }, `Entry ${index + 1}`));
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove"; remove.textContent = "Remove entry";
      remove.onclick = () => { apply(description.value.filter((_, itemIndex) => itemIndex !== index)); renderGuiEditor(); }; itemWrapper.append(remove); nested.append(itemWrapper);
    });
    const add = document.createElement("button"); add.type = "button"; add.className = "add-row"; add.textContent = "Add tuple entry";
    add.onclick = () => { apply([...description.value, "<String>"]); renderGuiEditor(); }; nested.append(add); wrapper.append(nested);
  }
  if (description.kind === "object") {
    const nested = document.createElement("div"); nested.className = "nested-editor";
    nested.append(nestedLabel("Object fields"), renderObjectFields(description.value, apply)); wrapper.append(nested);
  }
  return wrapper;
}

function renderObjectFields(object, apply) {
  const list = document.createElement("div"); list.className = "property-list";
  for (const [rawKey, value] of Object.entries(object)) {
    const field = document.createElement("div");
    const row = document.createElement("div"); row.className = "property-row";
    const key = document.createElement("input"); key.value = rawKey.endsWith("?") ? rawKey.slice(0, -1) : rawKey; key.placeholder = "Field name";
    const optional = document.createElement("label"); optional.className = "optional";
    const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.checked = rawKey.endsWith("?"); optional.append(toggle, document.createTextNode("Optional"));
    const rename = () => {
      const nextKey = `${key.value.replace(/\?+$/, "")}${toggle.checked ? "?" : ""}`;
      if (!nextKey || nextKey === rawKey) return;
      if (Object.hasOwn(object, nextKey)) return setStatus(`Field '${nextKey}' already exists.`, "error");
      const next = {};
      for (const [existingKey, existingValue] of Object.entries(object)) next[existingKey === rawKey ? nextKey : existingKey] = existingValue;
      apply(next); renderGuiEditor();
    };
    key.onchange = rename; toggle.onchange = rename;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove"; remove.textContent = "Remove";
    remove.onclick = () => { const next = { ...object }; delete next[rawKey]; apply(next); renderGuiEditor(); };
    row.append(key, optional, document.createElement("span"), remove); field.append(row);
    field.append(renderValueEditor(value, (nextValue) => apply({ ...object, [rawKey]: nextValue }), "Value")); list.append(field);
  }
  const add = document.createElement("button"); add.type = "button"; add.className = "add-row"; add.textContent = "Add field";
  add.onclick = () => {
    let index = 1; let key = "field";
    while (Object.hasOwn(object, key) || Object.hasOwn(object, `${key}?`)) key = `field${++index}`;
    apply({ ...object, [key]: "<String>" }); renderGuiEditor();
  };
  list.append(add); return list;
}

function updateGuiDocument(value) {
  guiDocument = value;
  replaceContent(`${JSON.stringify(guiDocument, null, 2)}\n`);
  markDirty();
}

function renderGuiEditor() {
  formEditor.replaceChildren();
  const intro = document.createElement("p"); intro.className = "form-intro";
  intro.textContent = "Edit nested schema values directly. Use JSON mode for raw source.";
  const root = document.createElement("p"); root.className = "root-label"; root.textContent = "Document";
  formEditor.append(intro, root, renderValueEditor(guiDocument, updateGuiDocument));
}

function setEditorMode(mode) {
  if (isFunctionFile()) return;
  if (mode === "gui") {
    try { guiDocument = JSON.parse(content()); } catch (error) { setStatus(`Fix JSON before using GUI mode: ${error.message}`, "error"); return; }
  }
  editorMode = mode;
  editorHost.hidden = mode !== "json";
  formEditor.hidden = mode !== "gui";
  editorModes.querySelectorAll("button").forEach((button) => { button.classList.toggle("active", button.dataset.mode === mode); });
  if (mode === "gui") renderGuiEditor(); else editor.focus();
}

function renderSuggestions() {
  const basic = ["<String>", "<Number>", "<Boolean>", "<Null>", "<function:name>"];
  const dynamic = ["class", "enum", "union", "function"].flatMap((kind) => (project.tokens[kind] || []).map((name) => `<${kind}:${name}>`));
  suggestions.replaceChildren(...[...basic, ...dynamic].map((token) => {
    const button = document.createElement("button"); button.textContent = token; button.onclick = () => insert(token); return button;
  }));
}

async function refresh(openCurrent = false) {
  project = await request("/api/project"); renderTree(); renderSuggestions();
  parentClass.replaceChildren(new Option("No parent", ""), ...project.classes.map((item) => new Option(item.name, item.path)));
  if (openCurrent && currentPath) await openFile(currentPath);
}

async function openFile(file) {
  if (currentPath && content() !== savedContent && !confirm("Discard unsaved changes?")) return;
  const result = await request(`/api/file?path=${encodeURIComponent(file)}`);
  currentPath = result.path; savedContent = result.content; fileName.textContent = currentPath;
  createEditor(result.content); editorMode = "json"; editorHost.hidden = false; formEditor.hidden = true;
  editorModes.hidden = isFunctionFile();
  editorModes.querySelectorAll("button").forEach((button) => { button.classList.toggle("active", button.dataset.mode === "json"); });
  markDirty(); renderTree();
  setStatus(isFunctionFile() ? "JavaScript editor with syntax linting." : "JSON editor with syntax validation.", "ok");
}

function diagnostics() {
  const parser = isFunctionFile() ? javascriptLanguage.parser : jsonLanguage.parser;
  const errors = [];
  parser.parse(content()).iterate({ enter(node) { if (node.type.isError) errors.push(node); } });
  return errors;
}

function validate() {
  if (!currentPath) return false;
  const errors = diagnostics();
  if (errors.length) {
    setStatus(`${isFunctionFile() ? "JavaScript" : "JSON"} syntax error${errors.length === 1 ? "" : "s"}: ${errors.length}.`, "error");
    return false;
  }
  setStatus(isFunctionFile() ? "JavaScript syntax is valid." : "Valid JSON.", "ok");
  return true;
}

async function save() {
  if (!currentPath || !validate()) return;
  const source = content();
  await request("/api/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: currentPath, content: source }) });
  savedContent = source.endsWith("\n") ? source : `${source}\n`;
  if (source !== savedContent) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: savedContent } });
  markDirty(); setStatus("Saved.", "ok"); await refresh();
}

document.querySelector("#refresh").onclick = () => refresh(true).catch((error) => setStatus(error.message, "error"));
document.querySelector("#format").onclick = () => {
  if (isFunctionFile()) return setStatus("Formatting is available for JSON definitions only.", "error");
  try {
    const formatted = `${JSON.stringify(JSON.parse(content()), null, 2)}\n`;
    replaceContent(formatted); if (editorMode === "gui") { guiDocument = JSON.parse(formatted); renderGuiEditor(); }
    markDirty(); setStatus("Formatted.", "ok");
  } catch (error) { setStatus(`JSON error: ${error.message}`, "error"); }
};
document.querySelector("#validate").onclick = validate;
document.querySelector("#save").onclick = () => save().catch((error) => setStatus(error.message, "error"));
editorModes.querySelectorAll("button").forEach((button) => { button.onclick = () => setEditorMode(button.dataset.mode); });
document.querySelector("#newDefinition").onclick = () => { definitionName.value = ""; definitionType.value = "class"; parentField.hidden = false; dialog.showModal(); definitionName.focus(); };
document.querySelector("#cancelCreate").onclick = () => dialog.close();
definitionType.onchange = () => { parentField.hidden = definitionType.value !== "class"; };
createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await request("/api/definition", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: definitionType.value, name: definitionName.value, parentPath: parentClass.value }) });
    project = result.project; dialog.close(); renderTree(); renderSuggestions(); await openFile(result.path); setStatus("Definition created.", "ok");
  } catch (error) { setStatus(error.message, "error"); }
});

refresh().then(() => openFile("config.json")).catch((error) => setStatus(error.message, "error"));
