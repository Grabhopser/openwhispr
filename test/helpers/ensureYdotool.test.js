const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Stub electron, the logger and child_process so the check runs without a real
// desktop and always sees "ydotool not installed".
const dialogCalls = [];
const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return { dialog: { showMessageBox: (opts) => dialogCalls.push(opts) } };
  }
  if (request === "./debugLogger") {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }
  if (request === "child_process") {
    return { spawnSync: () => ({ status: 1, stdout: Buffer.from("") }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ensureYdotool } = require("../../src/helpers/ensureYdotool");
Module._load = originalLoad;

function withWayland(fn) {
  return async () => {
    const saved = { type: process.env.XDG_SESSION_TYPE, display: process.env.WAYLAND_DISPLAY };
    process.env.XDG_SESSION_TYPE = "wayland";
    process.env.WAYLAND_DISPLAY = "wayland-0";
    dialogCalls.length = 0;
    try {
      await fn();
    } finally {
      process.env.XDG_SESSION_TYPE = saved.type ?? "";
      process.env.WAYLAND_DISPLAY = saved.display ?? "";
    }
  };
}

test(
  "no ydotool warning when paste already works another way",
  { skip: process.platform !== "linux" },
  withWayland(async () => {
    await ensureYdotool({ isPasteAvailable: () => true });
    assert.equal(dialogCalls.length, 0);
  })
);

test(
  "ydotool warning still shown when no paste method is available",
  { skip: process.platform !== "linux" },
  withWayland(async () => {
    await ensureYdotool({ isPasteAvailable: () => false });
    assert.equal(dialogCalls.length, 1);
    assert.equal(dialogCalls[0].title, "Wayland Paste Setup");
  })
);

test(
  "ydotool warning shown when no availability check is passed",
  { skip: process.platform !== "linux" },
  withWayland(async () => {
    await ensureYdotool();
    assert.equal(dialogCalls.length, 1);
  })
);
