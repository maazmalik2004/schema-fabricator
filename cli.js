const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { readJson } = require("./loader");
const { Fabricator, formatBytes, writeDocumentsLive } = require("./generator");

function clearOutputDirectory(outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const filename of fs.readdirSync(outputDirectory)) {
    fs.rmSync(path.join(outputDirectory, filename), {
      recursive: true,
      force: true,
    });
  }
}

function prepareOutputDirectory(outputDirectory, output = process.stdout) {
  if (fs.existsSync(outputDirectory)) {
    output.write(`Deleting files in ${outputDirectory}.\n`);
    clearOutputDirectory(outputDirectory);
    return;
  }
  output.write(`Creating ${outputDirectory}.\n`);
  fs.mkdirSync(outputDirectory, { recursive: true });
}

function formatConfiguration(config) {
  return Object.entries(config)
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)
    .join("\n");
}

function isAffirmative(answer) {
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

function formatConfirmationPrompt(output = process.stdout) {
  const choices = "[y/n/yes/no]";
  const highlightedChoices = output.isTTY ? `\x1b[31m${choices}\x1b[0m` : choices;
  return `Proceed with generation ${highlightedChoices}: `;
}

function confirmGeneration(input = process.stdin, output = process.stdout) {
  const prompt = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    prompt.question(formatConfirmationPrompt(output), (answer) => {
      prompt.close();
      resolve(isAffirmative(answer));
    });
  });
}

function createSpinner(label, stream = process.stdout) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let detail = "";
  let frame = 0;
  let timer;

  const render = (complete) => {
    const suffix =
      complete === undefined
        ? frames[frame++ % frames.length]
        : complete
          ? "✓"
          : "✖";
    const line = `${suffix} ${label}:${detail ? ` ${detail}` : ""}`;
    if (stream.isTTY) stream.write(`\r\x1b[2K${line}`);
    else stream.write(`${line}\n`);
  };

  return {
    start() {
      if (timer) return;
      render();
      timer = setInterval(render, stream.isTTY ? 80 : 500);
    },
    update(nextDetail) {
      detail = nextDetail;
      if (timer && stream.isTTY) render();
    },
    stop(success = true) {
      if (timer) clearInterval(timer);
      timer = undefined;
      render(success);
    },
  };
}

function formatGenerationProgress({ count, bytes, coverage }) {
  const coverageDetail = `coverage-${coverage.percentage}% (${coverage.fulfilled}/${coverage.total} decision branches)`;
  return `${count}  ${formatBytes(bytes)}  ${coverageDetail}`;
}

async function runCliStage(label, output, work) {
  const spinner = createSpinner(label, output);
  spinner.start();
  try {
    const result = await work(spinner);
    spinner.stop();
    if (output.isTTY) output.write("\n");
    return result;
  } catch (error) {
    spinner.stop(false);
    if (output.isTTY) output.write("\n");
    throw error;
  }
}

async function runCli({
  config = readJson(path.join(__dirname, "config.json")),
  definitionsDirectory = path.join(__dirname, "definitions"),
  outputDirectory = path.join(__dirname, "generated"),
  input = process.stdin,
  output = process.stdout,
  confirm = confirmGeneration,
} = {}) {
  const fabricator = await runCliStage(
    "Loading definitions",
    output,
    () => new Fabricator(definitionsDirectory, config),
  );
  if (fabricator.isRecursiveSchema(config.root)) {
    output.write("schema is recursive- skipping total possible documents calculation\n");
  } else {
    const possibilities = await runCliStage(
      "Planning possible documents",
      output,
      () => fabricator.buildPossibilityTree(config.root).possibilities,
    );
    output.write(`Estimated number of possible documents: ${possibilities}\n`);
  }
  output.write(`Configuration:\n${formatConfiguration(config)}\n`);
  output.write(
    `Coverage-based pruning is enabled: each decision branch targets ${fabricator.minOccurances} occurrence(s).\n`,
  );
  if (!(await confirm(input, output))) {
    output.write("Generation cancelled.\n");
    return 0;
  }

  await runCliStage("Preparing output directory", output, () =>
    prepareOutputDirectory(outputDirectory, output),
  );
  const count = await runCliStage(
    "Generating documents",
    output,
    (spinner) =>
      writeDocumentsLive(
        fabricator.generateTrees(config.root),
        outputDirectory,
        {
          onProgress: ({ count: completed, bytes }) =>
            spinner.update(formatGenerationProgress({
              count: completed,
              bytes,
              coverage: fabricator.coverageStats(),
            })),
          clearOutput: false,
        },
      ),
  );
  output.write(`Generated ${count} document(s) in ${outputDirectory}.\n`);
  return count;
}

module.exports = {
  confirmGeneration,
  createSpinner,
  formatConfirmationPrompt,
  formatGenerationProgress,
  formatConfiguration,
  isAffirmative,
  prepareOutputDirectory,
  runCli,
  runCliStage,
};

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
