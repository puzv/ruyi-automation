const { spawnSync } = require("child_process");

const VALID_ARCHES = new Set(["arm64", "x64"]);

function readSysctl(name) {
  const result = spawnSync("sysctl", ["-n", name], { encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function detectMacArchitecture({
  platform = process.platform,
  nodeArch = process.arch,
  env = process.env,
  sysctl = readSysctl,
} = {}) {
  const override = String(env.RUYI_BROWSER_ARCH || "").trim().toLowerCase();
  if (VALID_ARCHES.has(override)) return { arch: override, source: "RUYI_BROWSER_ARCH" };
  if (platform !== "darwin") {
    return VALID_ARCHES.has(nodeArch) ? { arch: nodeArch, source: "process.arch" } : { arch: null, source: "unsupported" };
  }
  if (nodeArch === "arm64") return { arch: "arm64", source: "process.arch" };

  // On Apple Silicon, an Intel Node launched through Rosetta reports x64.
  // sysctl.proc_translated is the reliable signal for that specific case.
  if (String(sysctl("sysctl.proc_translated")) === "1") {
    return { arch: "arm64", source: "sysctl.proc_translated" };
  }
  // This also covers native ARM when proc_translated is unavailable on an OS version.
  if (String(sysctl("hw.optional.arm64")) === "1") {
    return { arch: "arm64", source: "hw.optional.arm64" };
  }
  if (nodeArch === "x64") return { arch: "x64", source: "process.arch" };
  return { arch: null, source: "unknown" };
}

module.exports = { VALID_ARCHES, detectMacArchitecture };
