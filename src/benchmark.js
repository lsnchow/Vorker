import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AIDER_POLYGLOT_URL = "https://github.com/Aider-AI/polyglot-benchmark.git";
export const AIDER_POLYGLOT_COMMIT = "7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f";
export const DEFAULT_BENCHMARK_TASKS = [
  "two-bucket",
  "book-store",
  "variable-length-quantity",
];

const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_ROOT, "..");
const PROMPT_DIR = path.join(REPO_ROOT, "benchmarks", "prompts");
const EVAL_DIR = path.join(REPO_ROOT, "benchmarks", "evals");
const DEFAULT_USER_PROMPT =
  "Complete this Aider Polyglot exercise. Implement the production code so all existing tests pass. Do not modify tests. Work directly in the repository and finish the task.";

function runProcess(program, args, { cwd, timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const detached = process.platform !== "win32";
    const child = spawn(program, args, {
      cwd,
      env,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const stop = (signal) => {
      try {
        if (detached && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if (error?.code !== "ESRCH") {
          throw error;
        }
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), 1_000);
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return listFiles(candidate);
      }
      return [candidate];
    }),
  );
  return nested.flat().sort();
}

async function hashTestFiles(root) {
  const tests = (await listFiles(root)).filter((file) => file.endsWith("_test.py"));
  const digest = createHash("sha256");
  for (const file of tests) {
    digest.update(path.relative(root, file));
    digest.update(await readFile(file));
  }
  return { count: tests.length, hash: digest.digest("hex") };
}

function parseAgentEvents(jsonl) {
  let usage = null;
  let resolvedModel = null;
  let finalMessage = "";
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "turn.completed" && event.usage) {
        usage = event.usage;
      }
      if (event.type === "session.auto_mode_resolved") {
        resolvedModel = event.data?.chosenModel ?? resolvedModel;
      }
      if (event.type === "assistant.message") {
        resolvedModel = event.data?.model ?? resolvedModel;
        finalMessage = event.data?.content ?? finalMessage;
      }
      if (event.type === "result" && event.usage) {
        usage = event.usage;
      }
    } catch {
      // Codex may mix a diagnostic line into JSONL; preserve it as raw output instead.
    }
  }
  return { usage, resolvedModel, finalMessage };
}

function parseUnittestResult(output, expectedTotal) {
  const ran = Number.parseInt(output.match(/Ran (\d+) tests?/)?.[1] ?? "0", 10);
  const failures = Number.parseInt(output.match(/failures=(\d+)/)?.[1] ?? "0", 10);
  const errors = Number.parseInt(output.match(/errors=(\d+)/)?.[1] ?? "0", 10);
  const passed = Math.max(0, Math.min(expectedTotal, ran) - failures - errors);
  return { ran, failures, errors, passed, total: expectedTotal };
}

async function loadPrompts() {
  return {
    baseline: await readFile(path.join(PROMPT_DIR, "baseline.md"), "utf8"),
    vorker: await readFile(path.join(PROMPT_DIR, "vorker.md"), "utf8"),
  };
}

async function loadTaskEval(task) {
  const evalPath = path.join(EVAL_DIR, `${task}.md`);
  if (!(await pathExists(evalPath))) return { path: null, content: "" };
  return { path: path.relative(REPO_ROOT, evalPath), content: await readFile(evalPath, "utf8") };
}

async function ensurePinnedSource(cachePath) {
  const marker = path.join(cachePath, ".git");
  if (!(await pathExists(marker))) {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await rm(cachePath, { recursive: true, force: true });
    const init = await runProcess("git", ["init", "-q", cachePath]);
    if (init.code !== 0) throw new Error(`failed to initialize benchmark cache: ${init.stderr}`);
    const remote = await runProcess("git", ["remote", "add", "origin", AIDER_POLYGLOT_URL], {
      cwd: cachePath,
    });
    if (remote.code !== 0) throw new Error(`failed to configure benchmark source: ${remote.stderr}`);
  }

  const fetch = await runProcess(
    "git",
    ["fetch", "--depth", "1", "origin", AIDER_POLYGLOT_COMMIT],
    { cwd: cachePath, timeoutMs: 120_000 },
  );
  if (fetch.code !== 0) throw new Error(`failed to fetch Aider Polyglot: ${fetch.stderr}`);
  const checkout = await runProcess("git", ["checkout", "-q", "--detach", "FETCH_HEAD"], {
    cwd: cachePath,
  });
  if (checkout.code !== 0) throw new Error(`failed to checkout Aider Polyglot: ${checkout.stderr}`);
  return cachePath;
}

async function prepareWorkspace(source, task, tempRoot, trialId) {
  const sourceTask = path.join(source, "python", "exercises", "practice", task);
  if (!(await pathExists(sourceTask))) {
    throw new Error(`benchmark task not found: ${sourceTask}`);
  }
  const workspace = path.join(tempRoot, trialId);
  await cp(sourceTask, workspace, { recursive: true });
  const initialTests = await hashTestFiles(workspace);
  if (initialTests.count === 0) {
    throw new Error(`benchmark task has no Python tests: ${task}`);
  }

  for (const [program, args] of [
    ["git", ["init", "-q"]],
    ["git", ["add", "-A"]],
    [
      "git",
      [
        "-c",
        "user.name=Vorker Benchmark",
        "-c",
        "user.email=benchmark@vorker.local",
        "commit",
        "-qm",
        "benchmark fixture",
      ],
    ],
  ]) {
    const result = await runProcess(program, args, { cwd: workspace });
    if (result.code !== 0) throw new Error(`failed to prepare benchmark workspace: ${result.stderr}`);
  }
  const initialScorer = await runProcess(
    "python3",
    ["-m", "unittest", "discover", "-p", "*_test.py"],
    { cwd: workspace, timeoutMs: 60_000 },
  );
  const expectedTestCount = Number.parseInt(
    `${initialScorer.stdout}${initialScorer.stderr}`.match(/Ran (\d+) tests?/)?.[1] ?? "0",
    10,
  );
  if (expectedTestCount < 1) {
    throw new Error(`benchmark task did not expose runnable tests: ${task}`);
  }
  return { workspace, initialTests, expectedTestCount };
}

async function prepareCopilotInstructions(workspace, instructions) {
  if (!instructions) return;
  await writeFile(path.join(workspace, "AGENTS.md"), instructions);
  const add = await runProcess("git", ["add", "AGENTS.md"], { cwd: workspace });
  if (add.code !== 0) throw new Error(`failed to stage benchmark instructions: ${add.stderr}`);
  const commit = await runProcess(
    "git",
    [
      "-c",
      "user.name=Vorker Benchmark",
      "-c",
      "user.email=benchmark@vorker.local",
      "commit",
      "-qm",
      "add benchmark instructions",
    ],
    { cwd: workspace },
  );
  if (commit.code !== 0) throw new Error(`failed to commit benchmark instructions: ${commit.stderr}`);
}

async function runAgent({
  provider,
  variant,
  instructions,
  workspace,
  model,
  reasoning,
  timeoutMs,
  codexBin,
  copilotBin,
  finalMessagePath,
}) {
  if (provider === "copilot") {
    await prepareCopilotInstructions(workspace, variant === "vorker" ? instructions : null);
    const args = [
      "-C",
      workspace,
      "--model",
      model,
      "--allow-all-tools",
      "--no-ask-user",
      "--disable-builtin-mcps",
      "--no-auto-update",
      "--no-remote",
      "--no-remote-export",
      "--output-format",
      "json",
      "--stream",
      "off",
      "--log-level",
      "error",
    ];
    if (reasoning !== "auto") args.splice(4, 0, "--reasoning-effort", reasoning);
    if (variant === "baseline") args.push("--no-custom-instructions");
    args.push("--prompt", DEFAULT_USER_PROMPT);
    return runProcess(copilotBin, args, { cwd: workspace, timeoutMs });
  }

  if (provider !== "codex") throw new Error(`unknown benchmark provider: ${provider}`);
  return runProcess(
    codexBin,
    [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "-s",
      "workspace-write",
      "-C",
      workspace,
      "-m",
      model,
      "-c",
      `developer_instructions=${JSON.stringify(instructions)}`,
      "-c",
      `model_reasoning_effort=${JSON.stringify(reasoning)}`,
      "-o",
      finalMessagePath,
      DEFAULT_USER_PROMPT,
    ],
    { cwd: workspace, timeoutMs },
  );
}

function summarize(results, variants) {
  return Object.fromEntries(
    variants.map((variant) => {
      const trials = results.filter((result) => result.variant === variant);
      const passed = trials.filter((result) => result.passed).length;
      const durationMs = trials.reduce((sum, result) => sum + result.durationMs, 0);
      return [
        variant,
        {
          passed,
          total: trials.length,
          passRate: trials.length ? passed / trials.length : 0,
          meanDurationMs: trials.length ? Math.round(durationMs / trials.length) : 0,
          testCasesPassed: trials.reduce((sum, result) => sum + result.testCasesPassed, 0),
          testCasesTotal: trials.reduce((sum, result) => sum + result.testCasesTotal, 0),
          testPassRate:
            trials.reduce((sum, result) => sum + result.testCasesTotal, 0) > 0
              ? trials.reduce((sum, result) => sum + result.testCasesPassed, 0) /
                trials.reduce((sum, result) => sum + result.testCasesTotal, 0)
              : 0,
        },
      ];
    }),
  );
}

function renderMarkdown(report) {
  const lines = [
    "# Aider Polyglot Prompt Ablation",
    "",
    `Pinned upstream: \`${report.upstream.commit}\``,
    `Model: \`${report.config.model}\` · reasoning: \`${report.config.reasoning}\` · repeats: ${report.config.repeats}`,
    "",
    report.config.provider === "copilot"
      ? "Only Copilot repository instructions differ between variants. This tiny smoke subset is not an Aider leaderboard result."
      : "Only Codex developer instructions differ between variants. This tiny smoke subset is not an Aider leaderboard result.",
    "",
    "| Variant | Tasks passed | Test cases passed | Mean duration |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const variant of report.config.variants) {
    const summary = report.summary[variant];
    lines.push(
      `| ${variant} | ${summary.passed}/${summary.total} | ${summary.testCasesPassed}/${summary.testCasesTotal} (${(summary.testPassRate * 100).toFixed(1)}%) | ${(summary.meanDurationMs / 1_000).toFixed(1)}s |`,
    );
  }
  lines.push("", "## Trials", "", "| Task | Variant | Pass | Tests untouched | Duration |", "| --- | --- | --- | --- | ---: |");
  for (const result of report.results) {
    lines.push(
      `| ${result.task} | ${result.variant} | ${result.passed ? "yes" : "no"} | ${result.testsUntouched ? "yes" : "no"} | ${(result.durationMs / 1_000).toFixed(1)}s |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runBenchmark(options = {}) {
  const tasks = options.tasks ?? DEFAULT_BENCHMARK_TASKS;
  const variants = options.variants ?? ["baseline", "vorker"];
  const repeats = options.repeats ?? 1;
  const provider = options.provider ?? "copilot";
  const model = options.model ?? (provider === "copilot" ? "auto" : "gpt-5.4-mini");
  const reasoning = options.reasoning ?? (provider === "copilot" ? "auto" : "low");
  const timeoutMs = options.timeoutMs ?? 180_000;
  const codexBin = options.codexBin ?? process.env.CODEX_BIN ?? "codex";
  const copilotBin = options.copilotBin ?? process.env.COPILOT_BIN ?? "copilot";
  const outputPath = path.resolve(
    options.outputPath ?? path.join(REPO_ROOT, "benchmarks", "results", `${Date.now()}.json`),
  );
  const cachePath = path.join(REPO_ROOT, "benchmarks", ".cache", "aider-polyglot");
  const source = path.resolve(options.source ?? (await ensurePinnedSource(cachePath)));
  const prompts = await loadPrompts();

  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("benchmark repeats must be a positive integer");
  for (const variant of variants) {
    if (!prompts[variant]) throw new Error(`unknown benchmark variant: ${variant}`);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vorker-aider-benchmark-"));
  const results = [];
  try {
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const orderedVariants = (taskIndex + repeat) % 2 === 0 ? variants : [...variants].reverse();
        for (const variant of orderedVariants) {
          const trialId = `${taskIndex}-${repeat}-${variant}`;
          const { workspace, initialTests, expectedTestCount } = await prepareWorkspace(
            source,
            tasks[taskIndex],
            tempRoot,
            trialId,
          );
          const finalMessagePath = path.join(tempRoot, `${trialId}-final.txt`);
          const taskEval = await loadTaskEval(tasks[taskIndex]);
          const instructions =
            variant === "vorker" && taskEval.content
              ? `${prompts.vorker.trim()}\n\n<regression_eval>\n${taskEval.content.trim()}\n</regression_eval>`
              : prompts[variant].trim();
          const agent = await runAgent({
            provider,
            variant,
            instructions,
            workspace,
            model,
            reasoning,
            timeoutMs,
            codexBin,
            copilotBin,
            finalMessagePath,
          });
          const scorer = await runProcess(
            "python3",
            ["-m", "unittest", "discover", "-p", "*_test.py"],
            { cwd: workspace, timeoutMs: 60_000 },
          );
          const finalTests = await hashTestFiles(workspace);
          const diff = await runProcess("git", ["diff", "--numstat"], { cwd: workspace });
          const changed = await runProcess("git", ["diff", "--name-only"], { cwd: workspace });
          const testsUntouched = initialTests.hash === finalTests.hash;
          const testCases = parseUnittestResult(`${scorer.stdout}${scorer.stderr}`, expectedTestCount);
          const agentEvents = parseAgentEvents(agent.stdout);
          results.push({
            task: tasks[taskIndex],
            variant,
            repeat,
            passed: agent.code === 0 && scorer.code === 0 && testsUntouched,
            testsUntouched,
            agentExitCode: agent.code,
            scorerExitCode: scorer.code,
            testCasesPassed: scorer.code === 0 ? expectedTestCount : testCases.passed,
            testCasesTotal: expectedTestCount,
            timedOut: agent.timedOut,
            durationMs: agent.durationMs,
            usage: agentEvents.usage,
            resolvedModel: agentEvents.resolvedModel,
            evalMemory: variant === "vorker" ? taskEval.path : null,
            changedFiles: changed.stdout.trim().split("\n").filter(Boolean),
            diffNumstat: diff.stdout.trim().split("\n").filter(Boolean),
            finalMessage: (await pathExists(finalMessagePath))
              ? await readFile(finalMessagePath, "utf8")
              : agentEvents.finalMessage,
            agentStderr: agent.stderr,
            scorerOutput: `${scorer.stdout}${scorer.stderr}`,
          });
        }
      }
    }

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      upstream: { name: "Aider Polyglot", url: AIDER_POLYGLOT_URL, commit: AIDER_POLYGLOT_COMMIT },
      config: {
        tasks,
        variants,
        repeats,
        provider,
        model,
        reasoning,
        timeoutMs,
        userPrompt: DEFAULT_USER_PROMPT,
      },
      summary: summarize(results, variants),
      results,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    const markdownPath = outputPath.endsWith(".json")
      ? outputPath.replace(/\.json$/, ".md")
      : `${outputPath}.md`;
    await writeFile(markdownPath, renderMarkdown(report));
    return { ...report, outputPath, markdownPath };
  } finally {
    if (!options.keepWorkspaces) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

export async function runBenchmarkCommand(options) {
  const tasks = options.benchmarkTasks
    ? options.benchmarkTasks.split(",").map((task) => task.trim()).filter(Boolean)
    : DEFAULT_BENCHMARK_TASKS;
  const variants = options.benchmarkVariant === "both"
    ? ["baseline", "vorker"]
    : [options.benchmarkVariant ?? "baseline", options.benchmarkVariant ?? "vorker"].filter(
        (variant, index, all) => all.indexOf(variant) === index,
      );
  const report = await runBenchmark({
    source: options.benchmarkSource,
    tasks,
    variants,
    repeats: Number.parseInt(options.benchmarkRepeats ?? "1", 10),
    codexBin: options.codexBin,
    copilotBin: options.copilotBin,
    provider: options.benchmarkProvider,
    model: options.benchmarkModel,
    reasoning: options.benchmarkReasoning,
    timeoutMs: Number.parseInt(options.benchmarkTimeout ?? "180", 10) * 1_000,
    outputPath: options.benchmarkOutput,
    keepWorkspaces: options.keepWorkspaces,
  });
  process.stdout.write(
    `${JSON.stringify({ outputPath: report.outputPath, markdownPath: report.markdownPath, summary: report.summary }, null, 2)}\n`,
  );
}
