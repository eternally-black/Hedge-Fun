const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function windowsGitBash() {
  const candidates = [];
  for (const base of [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
  ]) {
    if (base) candidates.push(path.join(base, "Git", "bin", "bash.exe"));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }

  const located = spawnSync("where.exe", ["git.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (located.status === 0) {
    for (const line of located.stdout.split(/\r?\n/).filter(Boolean)) {
      const dir = path.dirname(line.trim());
      const leaf = path.basename(dir).toLowerCase();
      if (leaf === "cmd") candidates.push(path.join(path.dirname(dir), "bin", "bash.exe"));
      if (leaf === "bin") candidates.push(path.join(dir, "bash.exe"));
    }
  }

  return candidates.find((candidate) => fs.existsSync(candidate));
}

const script = path.join(__dirname, "with-docker-db.sh");
let bash = "bash";
if (process.platform === "win32") {
  bash = windowsGitBash();
  if (!bash) {
    console.error("Git Bash was not found. Install Git for Windows; refusing to fall back to WSL bash.exe.");
    process.exit(127);
  }
}

let command = process.argv.slice(2);
// Keep npm on the Node runtime that launched this helper. Git Bash's npm shim can otherwise
// select a different system Node installation even when the caller used a version manager.
if (command[0] === "npm" && process.env.npm_execpath) {
  command = [process.execPath, process.env.npm_execpath, ...command.slice(1)];
  if (process.platform === "win32") command = command.map((arg, i) => i < 2 ? arg.replaceAll("\\", "/") : arg);
}
const result = spawnSync(bash, [script, ...command], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(`Failed to launch ${bash}: ${result.error.message}`);
  process.exit(127);
}
if (result.signal) {
  const signalNumber = os.constants.signals[result.signal];
  process.exit(typeof signalNumber === "number" ? 128 + signalNumber : 1);
}
process.exit(result.status ?? 1);
