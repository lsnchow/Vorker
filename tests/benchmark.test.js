import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_BENCHMARK_TASKS, runBenchmark } from "../src/benchmark.js";

async function makeFixtureSource(root, task = "tiny-task") {
  const taskDir = path.join(root, "python", "exercises", "practice", task);
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "solution.py"), "def answer():\n    return 0\n");
  await writeFile(
    path.join(taskDir, "solution_test.py"),
    "import unittest\nfrom solution import answer\n\nclass TestAnswer(unittest.TestCase):\n    def test_answer(self):\n        self.assertEqual(answer(), 42)\n",
  );
  return task;
}

async function makeFakeCodex(root) {
  const fakeCodex = path.join(root, "codex");
  await writeFile(
    fakeCodex,
    `#!/bin/sh
case "$*" in
  *"fast, test-driven coding agent"*)
    printf 'def answer():\\n    return 42\\n' > solution.py
    ;;
esac
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
`,
  );
  await chmod(fakeCodex, 0o755);
  return fakeCodex;
}

async function makeFakeCopilot(root) {
  const fakeCopilot = path.join(root, "copilot");
  await writeFile(
    fakeCopilot,
    `#!/bin/sh
case "$*" in
  *"--no-custom-instructions"*) ;;
  *)
    grep -q "test-driven coding agent" AGENTS.md || exit 9
    printf 'def answer():\\n    return 42\\n' > solution.py
    ;;
esac
printf '%s\\n' '{"type":"assistant.message","usage":{"input_tokens":8,"output_tokens":3}}'
`,
  );
  await chmod(fakeCopilot, 0o755);
  return fakeCopilot;
}

test("benchmark defaults to a small pinned Aider Polyglot task set", () => {
  assert.deepEqual(DEFAULT_BENCHMARK_TASKS, [
    "two-bucket",
    "book-store",
    "variable-length-quantity",
  ]);
});

test("benchmark changes only developer instructions and scores upstream tests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorker-benchmark-test-"));
  const source = path.join(root, "source");
  const task = await makeFixtureSource(source);
  const codexBin = await makeFakeCodex(root);
  const outputPath = path.join(root, "result.json");

  const report = await runBenchmark({
    provider: "codex",
    source,
    tasks: [task],
    variants: ["baseline", "vorker"],
    repeats: 1,
    codexBin,
    model: "test-model",
    reasoning: "low",
    timeoutMs: 5_000,
    outputPath,
  });

  assert.equal(report.results.length, 2);
  assert.equal(report.results.find((result) => result.variant === "baseline").passed, false);
  assert.equal(report.results.find((result) => result.variant === "vorker").passed, true);
  assert.equal(report.results.every((result) => result.testsUntouched), true);
  assert.equal(report.config.model, "test-model");
  assert.equal(report.config.reasoning, "low");
  assert.equal(report.summary.baseline.passRate, 0);
  assert.equal(report.summary.vorker.passRate, 1);
  assert.equal(report.summary.baseline.testPassRate, 0);
  assert.equal(report.summary.vorker.testPassRate, 1);

  const persisted = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(persisted.upstream.commit.length, 40);
  assert.match(await readFile(outputPath.replace(/\.json$/, ".md"), "utf8"), /Prompt Ablation/);
});

test("benchmark rejects task names outside the pinned source tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorker-benchmark-missing-"));
  await assert.rejects(
    runBenchmark({
      provider: "codex",
      source: root,
      tasks: ["missing"],
      variants: ["baseline"],
      repeats: 1,
      codexBin: "/bin/false",
      model: "test-model",
      reasoning: "low",
      timeoutMs: 1_000,
      outputPath: path.join(root, "result.json"),
    }),
    /benchmark task not found/,
  );
});

test("Copilot benchmark disables custom instructions only for the baseline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorker-copilot-benchmark-"));
  const source = path.join(root, "source");
  const task = await makeFixtureSource(source);
  const copilotBin = await makeFakeCopilot(root);

  const report = await runBenchmark({
    provider: "copilot",
    source,
    tasks: [task],
    variants: ["baseline", "vorker"],
    repeats: 2,
    copilotBin,
    model: "gpt-5-mini",
    reasoning: "minimal",
    timeoutMs: 5_000,
    outputPath: path.join(root, "result.json"),
  });

  assert.equal(report.config.provider, "copilot");
  assert.deepEqual(
    report.results.map((result) => result.variant),
    ["baseline", "vorker", "vorker", "baseline"],
  );
  assert.equal(report.results.filter((result) => result.variant === "baseline").every((result) => !result.passed), true);
  assert.equal(report.results.filter((result) => result.variant === "vorker").every((result) => result.passed), true);
});
