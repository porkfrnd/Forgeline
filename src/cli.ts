#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import open from "open";
import { startServer } from "./server/index.js";
import { runGit, parseGitVersion, meetsMinVersion } from "./server/git/git.js";

export interface PortParse {
  port: number | null;
  error?: string;
}

export function parsePortArg(raw: string | undefined): PortParse {
  if (raw === undefined) return { port: 0 };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    return { port: null, error: `Invalid port "${raw}". Use a number from 1024 to 65535.` };
  }
  return { port: n };
}

async function checkGitVersion(): Promise<void> {
  const r = await runGit(["--version"], { cwd: process.cwd() });
  const v = parseGitVersion(r.stdout);
  if (!meetsMinVersion(v, 2, 31)) {
    console.error("Forgeline needs git 2.31 or newer to run.");
    console.error("Install git: https://git-scm.com/downloads");
    process.exit(1);
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("forgeline")
    .description("A calm, visual way to manage git repositories on localhost.")
    .version("0.1.0")
    .argument("[port]", "port number (1024-65535). Omit to pick a free port.")
    .option("--no-open", "do not open the browser automatically")
    .action(async (portArg: string | undefined, opts: { open: boolean }) => {
      await checkGitVersion();
      const parsed = parsePortArg(portArg);
      if (parsed.port === null) {
        console.error(parsed.error);
        program.outputHelp();
        process.exit(1);
      }
      const wantPort = parsed.port;
      try {
        const { server, actualPort, token } = await startServer({
          port: wantPort,
          hostname: "127.0.0.1",
        });
        const url = `http://localhost:${actualPort}/?t=${token}`;
        console.log(`Forgeline is running at ${url}`);
        if (opts.open) {
          await open(url);
        }
        const shutdown = () => {
          const srv = server as unknown as {
            closeAllConnections?: () => void;
            close: (cb: () => void) => void;
          };
          srv.closeAllConnections?.();
          srv.close(() => {
            console.log("Forgeline stopped. Goodbye.");
            process.exit(0);
          });
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (wantPort !== 0 && (/EADDRINUSE/i.test(msg) || /in use/i.test(msg))) {
          const next = wantPort + 1 <= 65535 ? wantPort + 1 : null;
          console.error(
            `Port ${wantPort} is in use.${next ? ` Try ${next}, or run forgeline with no port.` : " Run forgeline with no port."}`,
          );
          process.exit(1);
        }
        console.error(msg);
        process.exit(1);
      }
    });
  await program.parseAsync(argv);
}

function invokedAsMain(): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return realpathSync(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  void main(process.argv);
}
