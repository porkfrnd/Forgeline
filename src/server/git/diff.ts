import { runGit, withPaths, GIT_TIMEOUTS } from "./git.js";

/** One changed path, from `status --porcelain=v2`. */
export interface ChangeFile {
  /** Path as it is now. */
  path: string;
  /** The old path, for renames and copies. */
  originalPath?: string;
  /** Letter for the row: M modified, A added, D deleted, R renamed,
   *  C copied, T type changed, U conflicted. */
  letter: "M" | "A" | "D" | "R" | "C" | "T" | "U";
  /** True when the index differs from HEAD (staged). */
  staged: boolean;
  /** True when the worktree differs from the index (unstaged). */
  unstaged: boolean;
  /** True for an unmerged path, whatever its staged or unstaged state. */
  conflicted: boolean;
}

export type DiffLineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number on the old side, null for added lines. */
  oldLine: number | null;
  /** Line number on the new side, null for removed lines. */
  newLine: number | null;
  /** True when git reported no trailing newline on this line. */
  noEol: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  /** Binary files have no hunks. The viewer says so rather than showing
   *  mojibake. */
  binary: boolean;
  /** True when git refused to produce a diff, e.g. an unmerged path. */
  conflicted: boolean;
}

const STATUS_ENV = { GIT_OPTIONAL_LOCKS: "0" as string };

/** Parse `status --porcelain=v2 -z --branch` into changed paths.
 *
 *  `staged` comes from the index column (X) and `unstaged` from the
 *  worktree column (Y), so an `MM` file is staged *and* has further
 *  unstaged edits — exactly the case hunk staging has to keep straight.
 *
 *  Field layout, verified against real git output (paths may contain spaces,
 *  so the path is always the last field, joined back up):
 *    1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>              -> path is fields[7]
 *    2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>  -> path is fields[8],
 *       and with -z the original path is the next NUL record   -> origPath next
 *    u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>  -> path is fields[9]
 *    ? <path>                                                   -> untracked
 */
export function parseStatusFiles(porcelainV2Z: string): ChangeFile[] {
  const records = porcelainV2Z.split("\0");
  const out: ChangeFile[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length === 0 || record.startsWith("#")) continue;

    if (record.startsWith("u ")) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const fields = record.slice(2).split(" ");
      out.push({
        path: fields.slice(9).join(" "),
        letter: "U",
        staged: false,
        unstaged: false,
        conflicted: true,
      });
      continue;
    }

    if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const isRenameOrCopy = record.startsWith("2 ");
      const fields = record.slice(2).split(" ");
      const pathIndex = isRenameOrCopy ? 8 : 7;
      let path = fields.slice(pathIndex).join(" ");
      let originalPath: string | undefined;
      if (isRenameOrCopy) {
        // With -z the old path is the whole next record, not a field.
        const next = records[i + 1];
        if (next !== undefined && next.length > 0 && !/^[12u?!] /.test(next)) {
          originalPath = next;
          i += 1;
        } else if (originalPath === undefined) {
          originalPath = fields.slice(pathIndex).join(" ");
          path = fields.slice(pathIndex).join(" ");
        }
      }
      const x = fields[0][0] ?? ".";
      const y = fields[0][1] ?? ".";
      const letter: ChangeFile["letter"] =
        x === "R" || y === "R"
          ? "R"
          : x === "C" || y === "C"
            ? "C"
            : x === "A" || y === "A"
              ? "A"
              : x === "D" || y === "D"
                ? "D"
                : x === "T" || y === "T"
                  ? "T"
                  : "M";
      out.push({
        path,
        ...(originalPath !== undefined ? { originalPath } : {}),
        letter,
        staged: x !== ".",
        unstaged: y !== ".",
        conflicted: false,
      });
      continue;
    }

    if (record.startsWith("? ")) {
      // Untracked: nothing is staged, everything is in the worktree.
      out.push({
        path: record.slice(2),
        letter: "A",
        staged: false,
        unstaged: true,
        conflicted: false,
      });
    }
    // `!` ignored paths are deliberately not listed.
  }
  return out;
}

/** Split one file's unified diff into hunks. */
export function parseUnifiedDiff(unified: string, path: string): FileDiff {
  if (/^Binary files .* differ$/m.test(unified) || /^GIT binary patch$/m.test(unified)) {
    return { path, hunks: [], binary: true, conflicted: false };
  }

  const hunks: DiffHunk[] = [];
  const lines = unified.split("\n");
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (header) {
      current = {
        header: line,
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      oldNo = current.oldStart;
      newNo = current.newStart;
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("\\")) {
      // `\ No newline at end of file` qualifies the line before it.
      const previous = current.lines[current.lines.length - 1];
      if (previous) previous.noEol = true;
      continue;
    }
    const marker = line[0];
    if (marker === "+") {
      current.lines.push({
        kind: "add",
        text: line.slice(1),
        oldLine: null,
        newLine: newNo,
        noEol: false,
      });
      newNo += 1;
    } else if (marker === "-") {
      current.lines.push({
        kind: "del",
        text: line.slice(1),
        oldLine: oldNo,
        newLine: null,
        noEol: false,
      });
      oldNo += 1;
    } else if (marker === " ") {
      current.lines.push({
        kind: "context",
        text: line.slice(1),
        oldLine: oldNo,
        newLine: newNo,
        noEol: false,
      });
      oldNo += 1;
      newNo += 1;
    }
  }
  return { path, hunks, binary: false, conflicted: false };
}

/** Changed paths for a repo, staged and unstaged together. */
export async function readChangedFiles(repoPath: string): Promise<ChangeFile[]> {
  const res = await runGit(
    ["-C", repoPath, "status", "--porcelain=v2", "-z", "--branch"],
    { cwd: repoPath, env: STATUS_ENV },
  );
  if (res.exitCode !== 0) return [];
  return parseStatusFiles(res.stdout);
}

/** Diff one path. `staged` reads index against HEAD; unstaged reads the
 *  worktree against the index. Paths always go behind `--`. */
export async function readFileDiff(
  repoPath: string,
  path: string,
  staged: boolean,
  contextLines = 3,
): Promise<FileDiff> {
  const args = staged
    ? ["-C", repoPath, "diff", "--cached", "--no-color", `--unified=${contextLines}`]
    : ["-C", repoPath, "diff", "--no-color", `--unified=${contextLines}`];
  const res = await runGit(withPaths(args, [path]), {
    cwd: repoPath,
    env: STATUS_ENV,
    timeoutMs: GIT_TIMEOUTS.PATIENCE_MS,
  });
  if (res.exitCode !== 0) {
    const conflicted = /CONFLICT|does not have commits|unmerged/i.test(res.stderr);
    return { path, hunks: [], binary: false, conflicted };
  }
  if (res.stdout.trim().length === 0) return { path, hunks: [], binary: false, conflicted: false };
  return parseUnifiedDiff(res.stdout, path);
}

/** Whole-repo diff against HEAD, or against the index when not staged.
 *  Used by the viewer when no single file is selected. */
export async function readRepoDiff(
  repoPath: string,
  staged: boolean,
  contextLines = 3,
): Promise<FileDiff[]> {
  const args = staged
    ? ["-C", repoPath, "diff", "--cached", "--no-color", `--unified=${contextLines}`]
    : ["-C", repoPath, "diff", "--no-color", `--unified=${contextLines}`];
  const res = await runGit(args, { cwd: repoPath, env: STATUS_ENV });
  if (res.exitCode !== 0) return [];
  // Split per file on the `diff --git` marker, then parse each piece.
  const chunks = res.stdout.split(/^diff --git /m).filter((c) => c.trim().length > 0);
  return chunks
    .map((chunk) => {
      const first = chunk.split("\n")[0] ?? "";
      const m = first.match(/a\/(.+?) b\/(.+)$/);
      const path = m ? (m[2] ?? m[1] ?? "") : "";
      return parseUnifiedDiff(chunk, path);
    })
    .filter((d) => d.hunks.length > 0 || d.binary);
}
