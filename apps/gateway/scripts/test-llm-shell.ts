type ShellResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  cmd: string;
  timedOut?: boolean;
};

function shellEscape(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function splitCommandLine(commandLine: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i] ?? "";
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && quote === '"') {
        const next = commandLine[i + 1];
        if (next) {
          cur += next;
          i++;
          continue;
        }
      }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch as any;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    if (ch === "\\") {
      const next = commandLine[i + 1];
      if (next) {
        cur += next;
        i++;
        continue;
      }
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function buildShellCommand(program: string, args: string[], stdin?: string): string {
  const base = [program, ...args].map(shellEscape).join(" ");
  if (!stdin) return base;
  return `printf %s ${shellEscape(stdin)} | ${base}`;
}

async function runShellCommand(cmd: string, timeoutMs = 20000): Promise<ShellResult> {
  let timedOut = false;
  const proc = Bun.spawn({
    cmd: ["bash", "-lc", cmd],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? proc.stdout.text() : Promise.resolve(""),
    proc.stderr ? proc.stderr.text() : Promise.resolve(""),
    proc.exited,
  ]);
  clearTimeout(timeout);

  const ok = !timedOut && exitCode === 0;
  return {
    ok,
    stdout,
    stderr,
    exitCode: typeof exitCode === "number" ? exitCode : null,
    cmd,
    timedOut: timedOut ? true : undefined,
  };
}

async function commandExists(program: string): Promise<boolean> {
  const res = await runShellCommand(`command -v ${shellEscape(program)}`, 5000);
  return res.ok && res.stdout.trim().length > 0;
}

function detectHelloArgs(program: string, helpText: string): { args: string[]; stdin?: string } | null {
  const argsKey = `MCPMANAGER_${program.toUpperCase()}_HELLO_ARGS`;
  const stdinKey = `MCPMANAGER_${program.toUpperCase()}_HELLO_STDIN`;
  const envArgs = process.env[argsKey];
  if (envArgs && envArgs.trim().length > 0) {
    return { args: splitCommandLine(envArgs), stdin: process.env[stdinKey] };
  }

  if (program === "claude") {
    if (helpText.includes("--print")) {
      return { args: ["--print", "hello world"] };
    }
    return { args: ["hello world"] };
  }

  if (program === "codex") {
    if (helpText.includes("Run Codex non-interactively") || helpText.includes("\n  exec")) {
      return { args: ["exec", "hello world"] };
    }
    return { args: ["exec", "hello world"] };
  }

  const candidates = ["--prompt", "--message", "--query"];
  for (const flag of candidates) {
    if (helpText.includes(flag)) {
      return { args: [flag, "hello world"] };
    }
  }
  if (helpText.includes("--stdin")) {
    return { args: ["--stdin"], stdin: "hello world" };
  }
  if (/\[prompt\]|\[PROMPT\]|\[input\]|\[INPUT\]/.test(helpText)) {
    return { args: ["hello world"] };
  }
  return null;
}

function getTimeoutMs(): number {
  const raw = process.env.MCPMANAGER_LLM_TIMEOUT_MS;
  if (!raw) return 20000;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 20000;
}

async function runHello(program: string, helpText: string) {
  const hello = detectHelloArgs(program, helpText);
  if (!hello) {
    return { ok: false, skipped: true, reason: "No prompt flag detected; set MCPMANAGER_<TOOL>_HELLO_ARGS." };
  }
  const cmd = buildShellCommand(program, hello.args, hello.stdin);
  return runShellCommand(cmd, getTimeoutMs());
}

async function main() {
  const results: Record<string, unknown> = {};
  const tools = ["codex", "claude"] as const;
  let missing = false;

  for (const tool of tools) {
    const available = await commandExists(tool);
    if (!available) {
      results[tool] = { available: false, reason: `${tool} not found on PATH` };
      missing = true;
      continue;
    }
    const help = await runShellCommand(buildShellCommand(tool, ["--help"]), 5000);
    const version = await runShellCommand(buildShellCommand(tool, ["--version"]), 5000);
    const hello = await runHello(tool, help.stdout);
    results[tool] = { available: true, help, version, hello };
  }

  if (results.codex && results.claude) {
    const codex = results.codex as any;
    const claude = results.claude as any;
    if (codex.available && claude.available && !codex.hello?.skipped && !claude.hello?.skipped) {
      const codexHello = detectHelloArgs("codex", codex.help?.stdout ?? "");
      const claudeHello = detectHelloArgs("claude", claude.help?.stdout ?? "");
      if (codexHello && claudeHello) {
        const timeoutMs = getTimeoutMs();
        const [c, a] = await Promise.all([
          runShellCommand(buildShellCommand("codex", codexHello.args, codexHello.stdin), timeoutMs),
          runShellCommand(buildShellCommand("claude", claudeHello.args, claudeHello.stdin), timeoutMs),
        ]);
        results.parallel = { ok: true, codex: c, claude: a };
      }
    }
  }

  console.log(JSON.stringify(results, null, 2));
  if (missing) process.exit(1);
}

await main();
