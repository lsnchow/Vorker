import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { TaskWorkspaceManager } from "./git/task-workspace.js";

const execFileAsync = promisify(execFile);

function worktreeUsage() {
  return `vorker worktree

Usage:
  vorker worktree list
  vorker worktree create <name> [title...] [--base <ref>]
  vorker worktree remove <name|branch|path> [--force]

Notes:
  Vorker stores task worktrees under .vorker-2/worktrees in your git repo.
  The same worktree manager is used by orchestrated task dispatch.`;
}

async function resolveRepoRoot(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd });
    const primary = stdout
      .split("\n")
      .find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length)
      .trim();
    if (!primary) {
      throw new Error("git returned no worktrees");
    }
    return primary;
  } catch {
    throw new Error(`No git repository found from ${cwd}.`);
  }
}

function printWorkspace(workspace) {
  process.stdout.write(`Task worktree ready
Path: ${workspace.workspacePath}
Branch: ${workspace.branchName}
Base branch: ${workspace.baseBranch}
`);
}

function printWorkspaceList(list, worktreeRoot) {
  process.stdout.write(`Vorker task worktrees
Root: ${worktreeRoot}
`);

  if (list.length === 0) {
    process.stdout.write("No Vorker task worktrees yet.\n");
    return;
  }

  for (const item of list) {
    process.stdout.write(`\n${path.basename(item.workspacePath)}
Branch: ${item.branchName}
Path: ${item.workspacePath}
`);
  }
}

export async function runWorktree(options) {
  const [action = "list", ...args] = options.promptParts;
  if (options.help || action === "help") {
    process.stdout.write(`${worktreeUsage()}\n`);
    return;
  }

  const repoRoot = await resolveRepoRoot(options.cwd);
  const manager = new TaskWorkspaceManager({ repoRoot });

  if (action === "list") {
    const list = await manager.listTaskWorkspaces();
    printWorkspaceList(list, manager.worktreeRoot);
    return;
  }

  if (action === "add" || action === "create") {
    const [taskId, ...titleParts] = args;
    const title = titleParts.join(" ").trim() || taskId;
    if (!taskId) {
      throw new Error(worktreeUsage());
    }

    const workspace = await manager.ensureTaskWorkspace({
      taskId,
      title,
      baseBranch: options.base,
    });
    printWorkspace(workspace);
    return;
  }

  if (action === "remove") {
    const [identifier] = args;
    if (!identifier) {
      throw new Error(worktreeUsage());
    }
    const workspace = await manager.removeTaskWorkspace(identifier, {
      currentCwd: options.cwd,
      force: options.force,
    });
    process.stdout.write(`Removed Vorker worktree\nPath: ${workspace.workspacePath}\nBranch kept: ${workspace.branchName}\n`);
    return;
  }

  throw new Error(`Unknown worktree action: ${action}\n\n${worktreeUsage()}`);
}
