const test = require("node:test");
const assert = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");
const ParakeetServerManager = require("../../src/helpers/parakeetServer");
const { candidateLanguages } = require("../../src/helpers/transcribeCppServer");
const {
  getModelEngine,
  getRequiredModelFiles,
  resolveModelLanguage,
} = require("../../src/helpers/parakeetModelInfo");

const SAMPLE_RATE = 16000;
const TCPP_MODELS = Object.entries(modelData.parakeetModels).filter(
  ([, info]) => info.engine === "transcribe-cpp"
);

function wav(seconds) {
  const samples = seconds * SAMPLE_RATE;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, 44 + i * 2);
  return buf;
}

function fakeServer(name, { language } = {}) {
  const calls = [];
  return {
    name,
    calls,
    stopped: 0,
    running: false,
    maxConcurrentDecodes: 1,
    async start(modelName) {
      this.running = true;
      calls.push({ start: modelName });
    },
    async stop() {
      this.running = false;
      this.stopped++;
    },
    getStatus() {
      return { running: this.running, starting: false };
    },
    async resolveLanguage(_samples, options) {
      calls.push({ resolveLanguage: options });
      return { language, source: language ? "langid" : "model", languageMs: 5 };
    },
    async transcribe(samples, _rate, options) {
      calls.push({ transcribe: samples.length, language: options?.language });
      return { text: "hallo", elapsed: 1 };
    },
  };
}

function manager(tcpp, ws = fakeServer("ws")) {
  const m = new ParakeetServerManager();
  m.isModelDownloaded = () => true;
  m.tcppServer = tcpp;
  m.wsServer = ws;
  return m;
}

test("transcribe-cpp registry entries are pinned, checksummed single files", () => {
  assert.ok(TCPP_MODELS.length >= 2);
  for (const [name, info] of TCPP_MODELS) {
    assert.equal(getModelEngine(name), "transcribe-cpp");
    assert.ok(
      info.files.some((file) => file.name === "model.gguf"),
      name
    );
    for (const file of info.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/, `${name}/${file.name}`);
      // A branch name would let the file change under the checksum.
      assert.match(file.url, /\/resolve\/[a-f0-9]{40}\//, `${name}/${file.name}`);
      assert.ok(file.bytes > 0);
    }
    assert.equal(
      info.expectedSizeBytes,
      info.files.reduce((sum, file) => sum + file.bytes, 0),
      name
    );
    assert.deepEqual(
      getRequiredModelFiles(name),
      info.files.map((file) => file.name)
    );
    // Language never becomes part of the server identity for these models.
    assert.equal(resolveModelLanguage(name, "de"), null);
  }
  assert.equal(getModelEngine("parakeet-tdt-0.6b-v3"), "sherpa");
});

test("models that need a language ship the language-ID model with them", () => {
  for (const [name, info] of TCPP_MODELS) {
    const hasLangId = info.files.some((file) => file.name === "langid.gguf");
    assert.equal(info.languageDetection === "langid", hasLangId, name);
  }
});

test("language ID only chooses among the languages the user speaks", () => {
  const supported = ["de", "en", "fr", "lv", "hr"];
  assert.deepEqual(candidateLanguages(supported, ["de-DE", "en", "ja"]), ["de", "en"]);
  assert.deepEqual(candidateLanguages(["fr"], [], {}), ["fr"]);
});

test("without spoken languages, regional formats add their language to English", () => {
  const supported = ["de", "en", "fr", "lv", "hr"];
  const env = { LANG: "en_US.UTF-8", LC_TIME: "de_DE.UTF-8", LC_NUMERIC: "de_DE.UTF-8" };
  const candidates = candidateLanguages(supported, [], env);
  assert.ok(candidates.includes("de"));
  assert.ok(candidates.includes("en"));
  assert.ok(candidates.every((code) => supported.includes(code)));
  assert.ok(!candidates.includes("lv"));
});

test("a transcribe-cpp model routes to the transcribe.cpp server and stops sherpa", async () => {
  const tcpp = fakeServer("tcpp", { language: "de" });
  const ws = fakeServer("ws");
  ws.running = true;
  const m = manager(tcpp, ws);

  const result = await m.transcribe(wav(5), {
    modelName: "canary-1b-v2-gguf",
    language: "auto",
    spokenLanguages: ["de", "en"],
  });

  assert.equal(result.text, "hallo");
  assert.equal(result.language, "de");
  assert.equal(result.languageSource, "langid");
  assert.equal(ws.stopped, 1);
  assert.deepEqual(tcpp.calls[1].resolveLanguage.spokenLanguages, ["de", "en"]);
  assert.equal(tcpp.calls[2].language, "de");
  assert.equal(ws.calls.length, 0);
});

test("transcribe-cpp models keep long audio in 30s segments with one shared language", async () => {
  const tcpp = fakeServer("tcpp", { language: "en" });
  const m = manager(tcpp);

  await m.transcribe(wav(50), { modelName: "canary-1b-v2-gguf" });

  const decodes = tcpp.calls.filter((call) => call.transcribe);
  assert.equal(decodes.length, 2);
  assert.ok(decodes.every((call) => call.language === "en"));
  assert.ok(decodes.every((call) => call.transcribe <= 30 * SAMPLE_RATE * 4));
  assert.equal(tcpp.calls.filter((call) => call.resolveLanguage).length, 1);
});

test("sherpa models still route to the sherpa server and stop transcribe.cpp", async () => {
  const tcpp = fakeServer("tcpp");
  tcpp.running = true;
  const ws = fakeServer("ws");
  const m = manager(tcpp, ws);

  const result = await m.transcribe(wav(5), { modelName: "parakeet-tdt-0.6b-v3" });

  assert.equal(result.text, "hallo");
  assert.equal(result.language, undefined);
  assert.equal(tcpp.stopped, 1);
  assert.equal(tcpp.calls.filter((call) => call.transcribe).length, 0);
});

test("an empty decode under a detected language retries with the runner-up language", async () => {
  const tcpp = fakeServer("tcpp");
  tcpp.resolveLanguage = async () => ({
    language: "en",
    source: "langid",
    alternatives: ["de"],
  });
  const responses = [{ text: "" }, { text: "hallo welt" }];
  tcpp.transcribe = async (samples, _rate, options) => {
    tcpp.calls.push({ transcribe: samples.length, language: options?.language });
    return { elapsed: 1, ...responses.shift() };
  };
  const m = manager(tcpp);

  const result = await m.transcribe(wav(5), { modelName: "canary-1b-v2-gguf" });

  assert.deepEqual(
    tcpp.calls.filter((call) => call.transcribe).map((call) => call.language),
    ["en", "de"]
  );
  assert.equal(result.text, "hallo welt");
  assert.equal(result.language, "de");
});
