// Builds the screenshot fixture Update 4, section 7 asks for: at least six
// repositories, one with fourteen changed files covering M, A, D, R and U, one
// with very long file and branch names, one with about two thousand commits, and
// one with a single commit. All of it is real git; nothing is invented.
//
// Run via scripts/capture-screenshots.mjs, which tears it down afterwards.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export function buildFixture(root) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const inRepo = (name, fn) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const git = (...args) => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      if (r.status !== 0 && !args.includes("--quiet")) {
        throw new Error(`git ${args.join(" ")} failed in ${name}:\n${r.stderr}`);
      }
      return r;
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "fixture@forgeline.local");
    git("config", "user.name", "Fixture Author");
    git("config", "commit.gpgsign", "false");
    fn(dir, git);
    return dir;
  };

  // 1. The ordinary one: a small project with a real history.
  const ordinary = inRepo("ordinary", (dir, git) => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{\n  "name": "ordinary",\n  "version": "1.4.0"\n}\n');
    writeFileSync(join(dir, "src", "app.ts"), "export const start = 1;\n");
    writeFileSync(join(dir, "src", "core.ts"), "export const core = 0;\n");
    git("add", "-A");
    git("commit", "-qm", "feat: the start");
    // Each write is genuinely different, so every commit has something to record.
    for (let i = 0; i < 9; i++) {
      writeFileSync(join(dir, "src", "core.ts"), `export const core = ${i + 1};\n`);
      git("commit", "-qam", i % 3 === 0 ? `feat: change number ${i}` : `fix: a repair ${i}`);
    }
    git("tag", "v1.4.0");
    git("checkout", "-qb", "feature/the-thing");
    writeFileSync(join(dir, "src", "app.ts"), "export const start = 21;\n");
    git("commit", "-qam", "feat: width work");
    git("checkout", "-q", "main");
    writeFileSync(join(dir, "src", "app.ts"), "export const start = 11;\n");
  });

  // 2. The one with fourteen changed files and every status.
  const busy = inRepo("busy", (dir, git) => {
    mkdirSync(join(dir, "src"), { recursive: true });
    // Twenty existing files, so there are fourteen changes to make.
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(dir, "src", `file-${i}.ts`), `export const v${i} = ${i};\n`);
    }
    writeFileSync(join(dir, "package.json"), '{\n  "name": "busy",\n  "version": "0.9.1"\n}\n');
    git("add", "-A");
    git("commit", "-qm", "feat: twenty files");
    git("tag", "v0.9.1");
    // 6 modified, 3 added, 3 deleted, 1 renamed = 13 in the index.
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(dir, "src", `file-${i}.ts`), `export const v${i} = ${i + 100};\n`);
    }
    for (let i = 6; i < 9; i++) {
      writeFileSync(join(dir, "src", `added-${i}.ts`), `export const a${i} = true;\n`);
    }
    for (let i = 9; i < 12; i++) {
      rmSync(join(dir, "src", `file-${i}.ts`));
    }
    git("mv", "src/file-12.ts", "src/renamed-file.ts");
    git("add", "-A");
    // And one more modified so the unstaged column is not empty either.
    writeFileSync(join(dir, "src", "file-13.ts"), "export const v13 = 113;\n");
    // Fourteen changed files: 6 modified, 3 added, 3 deleted, 1 renamed, then
    // this one left unstaged — M, A, D, R and U all present at once.
    writeFileSync(join(dir, "src", "renamed-file.ts"), "export const v12 = 120;\n");
  });

  // 3. Long names, so the ellipsis and the pill both get exercised.
  const longNames = inRepo("long-names", (dir, git) => {
    const deep = join(dir, "a", "fairly", "long", "directory", "chain", "that", "keeps", "going");
    mkdirSync(deep, { recursive: true });
    writeFileSync(
      join(deep, "a-file-with-a-name-long-enough-to-need-ellipsising-in-any-sane-sidebar.ts"),
      "export const long = 1;\n",
    );
    writeFileSync(join(dir, "package.json"), '{\n  "name": "long",\n  "version": "1.0.0"\n}\n');
    git("add", "-A");
    git("commit", "-qm", "feat: a deeply nested file with an unreasonable name");
    git("checkout", "-qb", "feature/a-branch-name-long-enough-to-be-truncated-in-the-toolbar");
    writeFileSync(join(dir, "package.json"), '{\n  "name": "long",\n  "version": "1.0.1"\n}\n');
    git("commit", "-qam", "chore: bump");
    git("checkout", "-q", "main");
    writeFileSync(join(dir, "package.json"), '{\n  "name": "long",\n  "version": "1.0.2"\n}\n');
  });

  // 4. Deep history, so the graph and the log virtualize rather than pretend.
  const deep = inRepo("deep-history", (dir, git) => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# deep\n");
    git("add", "-A");
    git("commit", "-qm", "feat: the initial commit");
    // Two thousand commits is the sort of repo that makes a naive log useless.
    for (let i = 0; i < 2000; i++) {
      writeFileSync(join(dir, "README.md"), `# deep\n\ncommit ${i}\n`);
      git("commit", "-qam", i % 5 === 0 ? `feat: milestone ${i}` : `chore: touch ${i}`);
    }
  });

  // 5. A single commit, for the empty-ish states.
  const single = inRepo("single-commit", (dir, git) => {
    writeFileSync(join(dir, "notes.txt"), "one commit only\n");
    git("add", "-A");
    git("commit", "-qm", "feat: the only commit");
  });

  // 6. A stopped merge, so the conflict state is reachable for a capture.
  const conflicted = inRepo("conflicted", (dir, git) => {
    writeFileSync(join(dir, "shared.txt"), "the first line\n");
    git("add", "-A");
    git("commit", "-qm", "feat: start");
    git("checkout", "-qb", "theirs");
    writeFileSync(join(dir, "shared.txt"), "their line\n");
    git("commit", "-qam", "feat: their change");
    git("checkout", "-q", "main");
    writeFileSync(join(dir, "shared.txt"), "our line\n");
    git("commit", "-qam", "feat: our change");
    // A merge that stops. Deliberately non-zero exit, so ignore the status.
    spawnSync("git", ["merge", "theirs"], { cwd: dir, encoding: "utf8" });
  });

  return { ordinary, busy, longNames, deep, single, conflicted };
}
