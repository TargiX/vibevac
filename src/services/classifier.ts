import type { Classification, GitInspection } from "../domain/types.js";

const DAY_IN_MS = 86_400_000;

interface ClassificationContext {
  activeProcessCount: number | null;
  now?: number;
  staleAfterDays?: number;
}

export function classifyWorkspace(
  git: GitInspection | null,
  context: ClassificationContext = { activeProcessCount: null },
): Classification {
  if (!git) {
    return {
      dataSafety: "unknown",
      recommendation: "protect",
      reasons: ["Git inspection failed"],
    };
  }

  if (git.dirtyEntries > 0) {
    const untrackedDetail =
      git.untrackedEntries > 0 ? `, including ${git.untrackedEntries} untracked` : "";
    return {
      dataSafety: "local-only",
      recommendation: "protect",
      reasons: [`${git.dirtyEntries} uncommitted entries${untrackedDetail}`],
    };
  }

  if (git.kind === "standalone-repository") {
    return {
      dataSafety: "unknown",
      recommendation: "protect",
      reasons: ["standalone repository; removal would delete its Git database"],
    };
  }

  if (git.upstream && git.ahead === null) {
    return {
      dataSafety: "unknown",
      recommendation: "protect",
      reasons: ["could not compare HEAD with its upstream"],
    };
  }

  if (git.ahead !== null && git.ahead > 0) {
    return {
      dataSafety: "local-only",
      recommendation: "protect",
      reasons: [`${git.ahead} commit${git.ahead === 1 ? "" : "s"} ahead of upstream`],
    };
  }

  if (!git.upstream && !git.remoteContainsHead) {
    return {
      dataSafety: "local-only",
      recommendation: "protect",
      reasons: ["current commit is not proven to exist on a remote"],
    };
  }

  if (context.activeProcessCount !== null && context.activeProcessCount > 0) {
    return {
      dataSafety: "recoverable",
      recommendation: "keep",
      reasons: [
        `${context.activeProcessCount} running process${context.activeProcessCount === 1 ? " has" : "es have"} a working directory here`,
      ],
    };
  }

  const staleAfterDays = context.staleAfterDays ?? 14;
  const activityAgeDays = git.lastActivityAt
    ? Math.max(
        0,
        Math.floor(((context.now ?? Date.now()) - Date.parse(git.lastActivityAt)) / DAY_IN_MS),
      )
    : null;

  if (activityAgeDays !== null && activityAgeDays < staleAfterDays) {
    return {
      dataSafety: "recoverable",
      recommendation: "keep",
      reasons: [
        `merged workspace was active ${activityAgeDays === 0 ? "today" : `${activityAgeDays}d ago`}`,
      ],
    };
  }

  if (!git.branch) {
    return {
      dataSafety: "recoverable",
      recommendation: "review",
      reasons: ["HEAD is recoverable but detached from a branch"],
    };
  }

  if (git.mergedIntoDefault !== true) {
    return {
      dataSafety: "recoverable",
      recommendation: "review",
      reasons: [
        git.mergedIntoDefault === false
          ? `HEAD is not merged into ${git.defaultBranch ?? "the default branch"}`
          : "could not prove that HEAD is merged into the default branch",
      ],
    };
  }

  if (context.activeProcessCount === null) {
    return {
      dataSafety: "recoverable",
      recommendation: "review",
      reasons: ["active-process check was unavailable"],
    };
  }

  if (activityAgeDays === null) {
    return {
      dataSafety: "recoverable",
      recommendation: "review",
      reasons: ["last workspace activity is unknown"],
    };
  }

  return {
    dataSafety: "recoverable",
    recommendation: "candidate",
    reasons: [
      `clean, synced, merged into ${git.defaultBranch}, and inactive for ${activityAgeDays}d`,
    ],
  };
}
