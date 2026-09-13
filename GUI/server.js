const fs = require("fs");
const http = require("http");
const path = require("path");
const esbuild = require("esbuild");

const projectRoot = path.resolve(__dirname, "..");
const guiRoot = path.resolve(__dirname);
const definitionsRoot = path.join(projectRoot, "definitions");
const configFile = path.join(projectRoot, "config.json");
const port = Number(process.env.SCHEMA_FABRICATOR_GUI_PORT || 4173);
const assetsRoot = path.join(guiRoot, "public");

function buildClient() {
  fs.mkdirSync(assetsRoot, { recursive: true });
  esbuild.buildSync({
    entryPoints: [path.join(guiRoot, "app.js")],
    bundle: true,
    format: "esm",
    target: "es2020",
    outfile: path.join(assetsRoot, "app.js"),
  });
}

function relative(filename) {
  return path.relative(projectRoot, filename).split(path.sep).join("/");
}

function safeProjectFile(requested) {
  if (typeof requested !== "string" || !requested) throw new Error("A file path is required.");
  const filename = path.resolve(projectRoot, requested);
  const inDefinitions = filename === definitionsRoot || filename.startsWith(`${definitionsRoot}${path.sep}`);
  if (filename !== configFile && !inDefinitions) throw new Error("Only config.json and files in definitions/ are available.");
  return filename;
}

function definitionFiles(directory = definitionsRoot) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory() ? definitionFiles(filename) : entry.isFile() ? [filename] : [];
    });
}

function projectSnapshot() {
  const files = [configFile, ...definitionFiles()]
    .filter((filename) => fs.existsSync(filename))
    .map((filename) => relative(filename));
  const classes = files
    .filter((filename) => filename.endsWith(".class.json"))
    .map((filename) => ({
      path: filename,
      name: path.basename(filename, ".class.json"),
    }));
  const names = (suffix) => files
    .filter((filename) => filename.endsWith(suffix))
    .map((filename) => path.basename(filename, suffix));
  return {
    files,
    classes,
    tokens: {
      class: classes.map(({ name }) => name),
      enum: names(".enum.json"),
      union: names(".union.json"),
      function: names(".function.js"),
      state: names(".state.json"),
    },
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Request body is too large."));
    });
    request.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("Request body must be JSON.")); }
    });
    request.on("error", reject);
  });
}

function send(response, status, value, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(value));
}

function createDefinition({ type, name, parentPath }) {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name || "")) {
    throw new Error("Names must start with a letter and may use letters, numbers, hyphens, or underscores.");
  }
  const templates = {
    enum: "[\n  \"first\",\n  \"second\"\n]\n",
    union: "[\n  \"<String>\"\n]\n",
    state: "{}\n",
    function: `function ${name}() {\n  return undefined;\n}\n`,
    class: "{}\n",
  };
  if (!Object.hasOwn(templates, type)) throw new Error("Unknown definition type.");
  let filename;
  if (type === "class" && parentPath) {
    const parent = safeProjectFile(parentPath);
    if (!parent.endsWith(".class.json")) throw new Error("A class parent is required for nested classes.");
    filename = path.join(parent.slice(0, -".json".length), `${name}.class.json`);
  } else {
    const directories = { class: "classes", enum: "enums", union: "unions", function: "functions", state: "state" };
    const suffixes = { class: ".class.json", enum: ".enum.json", union: ".union.json", function: ".function.js", state: ".state.json" };
    filename = path.join(definitionsRoot, directories[type], `${name}${suffixes[type]}`);
  }
  if (fs.existsSync(filename)) throw new Error(`${relative(filename)} already exists.`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, templates[type]);
  return relative(filename);
}

function staticFile(requestPath) {
  const decoded = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath);
  const root = decoded.startsWith("/assets/") ? assetsRoot : guiRoot;
  const localPath = decoded.startsWith("/assets/") ? decoded.slice("/assets".length) : decoded;
  const filename = path.resolve(root, `.${localPath}`);
  if (!filename.startsWith(`${root}${path.sep}`)) return undefined;
  return filename;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/api/project") return send(response, 200, projectSnapshot());
    if (request.method === "GET" && url.pathname === "/api/file") {
      const filename = safeProjectFile(url.searchParams.get("path"));
      return send(response, 200, { path: relative(filename), content: fs.readFileSync(filename, "utf8") });
    }
    if (request.method === "PUT" && url.pathname === "/api/file") {
      const { path: requested, content } = await readBody(request);
      const filename = safeProjectFile(requested);
      if (typeof content !== "string") throw new Error("File content must be text.");
      if (filename.endsWith(".json")) JSON.parse(content);
      fs.writeFileSync(filename, content.endsWith("\n") ? content : `${content}\n`);
      return send(response, 200, { path: relative(filename) });
    }
    if (request.method === "POST" && url.pathname === "/api/definition") {
      const filename = createDefinition(await readBody(request));
      return send(response, 201, { path: filename, project: projectSnapshot() });
    }
    if (request.method === "GET") {
      const filename = staticFile(url.pathname);
      if (!filename || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
        response.writeHead(404); response.end("Not found"); return;
      }
      const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
      response.writeHead(200, { "Content-Type": `${types[path.extname(filename)] || "application/octet-stream"}; charset=utf-8` });
      fs.createReadStream(filename).pipe(response);
      return;
    }
    response.writeHead(405); response.end("Method not allowed");
  } catch (error) {
    send(response, 400, { error: error.message });
  }
});

buildClient();
server.listen(port, () => {
  process.stdout.write(`Schema designer: http://localhost:${port}\n`);
});
