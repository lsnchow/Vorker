import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vorker-worktree-command-"));
  await git(repoRoot, "init", "-b", "main");
  await git(repoRoot, "config", "user.name", "Vorker Test");
  await git(repoRoot, "config", "user.email", "vorker@example.com");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "src", "index.js"), "export const value = 1;\n", "utf8");
  await git(repoRoot, "add", ".");
  await git(repoRoot, "commit", "-m", "init");
  return repoRoot;
}

async function runVorker(cwd, ...args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, ["src/index.js", ...args], {
    cwd: projectRoot,
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  return { stdout, stderr };
}

test("worktree create provisions a reusable task worktree from a repo subdirectory", async () => {
  const repoRoot = await createRepo();
  const nestedCwd = path.join(repoRoot, "src");
  const { stdout } = await runVorker(
    nestedCwd,
    "--cwd",
    nestedCwd,
    "worktree",
    "create",
    "task-7",
    "Fix",
    "parser",
  );

  const pathMatch = stdout.match(/^Path: (.+)$/m);
  const branchMatch = stdout.match(/^Branch: (.+)$/m);

  assert.ok(pathMatch, stdout);
  assert.ok(branchMatch, stdout);

  const workspacePath = pathMatch[1];
  const branchName = await git(workspacePath, "branch", "--show-current");

  assert.equal(branchName, branchMatch[1]);
  assert.match(workspacePath, /\/\.vorker-2\/worktrees\/task-7-fix-parser$/);
});

test("worktree list shows Vorker-managed task worktrees only", async () => {
  const repoRoot = await createRepo();
  await git(repoRoot, "worktree", "add", path.join(repoRoot, "manual-worktree"), "-b", "manual-branch");
  const created = await runVorker(
    repoRoot,
    "--cwd",
    repoRoot,
    "worktree",
    "create",
    "task-9",
    "Stabilize",
    "runtime",
  );
  const managedPath = created.stdout.match(/^Path: (.+)$/m)?.[1];
  assert.ok(managedPath, created.stdout);

  const { stdout } = await runVorker(managedPath, "--cwd", managedPath, "worktree", "list");

  assert.match(stdout, /Vorker task worktrees/);
  assert.match(stdout, /task-9-stabilize-runtime/);
  assert.match(stdout, /vorker\/task-task-9-stabilize-runtime/);
  assert.doesNotMatch(stdout, /manual-worktree/);
  assert.doesNotMatch(stdout, /manual-branch/);
});

test("worktree remove protects dirty and active worktrees unless explicitly forced", async () => {
  const repoRoot = await createRepo();
  const created = await runVorker(
    repoRoot,
    "--cwd",
    repoRoot,
    "worktree",
    "create",
    "cleanup",
    "Safe",
    "removal",
  );
  const workspacePath = created.stdout.match(/^Path: (.+)$/m)?.[1];
  assert.ok(workspacePath, created.stdout);
  const workspaceName = path.basename(workspacePath);

  await writeFile(path.join(workspacePath, "dirty.txt"), "keep me\n", "utf8");

  await assert.rejects(
    runVorker(repoRoot, "--cwd", repoRoot, "worktree", "remove", workspaceName),
    /changed file\(s\).*--force/,
  );
  await assert.rejects(
    runVorker(workspacePath, "--cwd", workspacePath, "worktree", "remove", workspaceName, "--force"),
    /Refusing to remove the active worktree/,
  );

  const removed = await runVorker(
    repoRoot,
    "--cwd",
    repoRoot,
    "worktree",
    "remove",
    workspaceName,
    "--force",
  );
  assert.match(removed.stdout, /Removed Vorker worktree/);
  assert.doesNotMatch(await git(repoRoot, "worktree", "list", "--porcelain"), new RegExp(workspaceName));
  assert.equal(await git(repoRoot, "show-ref", "--verify", "--quiet", "refs/heads/vorker/task-cleanup-safe-removal"), "");
});
