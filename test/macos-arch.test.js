const assert = require("node:assert/strict");
const { detectMacArchitecture } = require("@ruyi/shared/macos-arch");

function detect(options = {}, values = {}) {
  const calls = [];
  const result = detectMacArchitecture({
    platform: "darwin",
    nodeArch: "x64",
    env: {},
    sysctl: (name) => {
      calls.push(name);
      return values[name] ?? "";
    },
    ...options,
  });
  return { result, calls };
}

const nativeArm = detect({ nodeArch: "arm64" });
assert.deepEqual(nativeArm.result, { arch: "arm64", source: "process.arch" });
assert.deepEqual(nativeArm.calls, []);

assert.deepEqual(detect({}, {
  "sysctl.proc_translated": "1",
}).result, { arch: "arm64", source: "sysctl.proc_translated" });

assert.deepEqual(detect({}, {
  "hw.optional.arm64": "1",
}).result, { arch: "arm64", source: "hw.optional.arm64" });

assert.deepEqual(detect({}, {
  "sysctl.proc_translated": "0",
  "hw.optional.arm64": "0",
}).result, { arch: "x64", source: "process.arch" });

// Intel Macs can lack both sysctl keys; retain the Node architecture fallback.
assert.deepEqual(detect().result, { arch: "x64", source: "process.arch" });

for (const arch of ["arm64", "x64"]) {
  const overridden = detect({ env: { RUYI_BROWSER_ARCH: ` ${arch.toUpperCase()} ` } });
  assert.deepEqual(overridden.result, { arch, source: "RUYI_BROWSER_ARCH" });
  assert.deepEqual(overridden.calls, []);
}
assert.deepEqual(detect({ env: { RUYI_BROWSER_ARCH: "invalid" } }, {
  "sysctl.proc_translated": "1",
}).result, { arch: "arm64", source: "sysctl.proc_translated" });

for (const platform of ["linux", "win32"]) {
  for (const nodeArch of ["arm64", "x64"]) {
    const native = detect({ platform, nodeArch });
    assert.deepEqual(native.result, { arch: nodeArch, source: "process.arch" });
    assert.deepEqual(native.calls, []);
  }
  assert.deepEqual(detect({ platform, nodeArch: "ia32" }).result, {
    arch: null, source: "unsupported",
  });
}
assert.deepEqual(detect({ nodeArch: "unknown" }).result, { arch: null, source: "unknown" });

console.log("macOS architecture checks passed");
