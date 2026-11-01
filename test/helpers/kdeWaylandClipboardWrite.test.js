const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const childProcess = require("node:child_process");

// On KDE Wayland OpenWhispr runs under XWayland. Text written only to the X11
// clipboard reaches native Wayland apps (e.g. Chromium/Vivaldi) through KWin's
// bridge, which can hand them a stale selection. The text must also be written
// to the Wayland clipboard directly.

const fakeClipboard = {
  writes: [],
  writeText(text) {
    this.writes.push(text);
  },
};

function loadClipboardManager(spawnSync) {
  const modulePath = require.resolve("../../src/helpers/clipboard");
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return { clipboard: fakeClipboard, systemPreferences: {} };
    }
    if (request === "child_process") {
      return { ...childProcess, spawnSync };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../../src/helpers/clipboard");
  } finally {
    Module._load = originalLoad;
  }
}

function withKdeWayland(fn) {
  const keys = ["XDG_SESSION_TYPE", "WAYLAND_DISPLAY", "XDG_CURRENT_DESKTOP", "DISPLAY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    XDG_SESSION_TYPE: "wayland",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_CURRENT_DESKTOP: "KDE",
    DISPLAY: ":0",
  });
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function recordingSpawnSync(calls, available) {
  return (command, args = [], options = {}) => {
    if (command === "sh" && args[0] === "-c") {
      const name = args[1].replace("command -v ", "");
      return { status: available.includes(name) ? 0 : 1 };
    }
    calls.push({ command, args, input: options.input });
    return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
  };
}

test("KDE Wayland writes X11 and Wayland clipboard", { skip: process.platform !== "linux" }, () => {
  const calls = [];
  fakeClipboard.writes = [];
  const ClipboardManager = loadClipboardManager(recordingSpawnSync(calls, ["xclip", "wl-copy"]));
  withKdeWayland(() => new ClipboardManager()._writeClipboardWayland("hallo welt", null));

  const xclip = calls.find((c) => c.command === "xclip");
  const wlCopy = calls.find((c) => c.command === "wl-copy");
  assert.ok(xclip, "X11 clipboard still written via xclip");
  assert.deepEqual(fakeClipboard.writes, ["hallo welt"]);
  assert.ok(wlCopy, "Wayland clipboard written via wl-copy");
  assert.equal(wlCopy.input, "hallo welt");
  assert.ok(!wlCopy.args.includes("hallo welt"), "text must not appear in argv");
});

test(
  "KDE Wayland without wl-copy keeps X11-only behaviour",
  { skip: process.platform !== "linux" },
  () => {
    const calls = [];
    fakeClipboard.writes = [];
    const ClipboardManager = loadClipboardManager(recordingSpawnSync(calls, ["xclip"]));
    withKdeWayland(() => new ClipboardManager()._writeClipboardWayland("hallo", null));

    assert.ok(calls.find((c) => c.command === "xclip"));
    assert.equal(
      calls.find((c) => c.command === "wl-copy"),
      undefined
    );
    assert.deepEqual(fakeClipboard.writes, ["hallo"]);
  }
);
