// Run with: node tests/data.test.js. APP_SOURCE supports an embedded JS runtime.
const appSource = typeof require === 'function'
  ? require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8')
  : APP_SOURCE;
const appScript = appSource.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(appScript);
function section(from, to) {
  const start = appScript.indexOf(from), end = appScript.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`Missing application section: ${from}`);
  return appScript.slice(start, end);
}
const dataSource = [
  section('const SPS_OF =', 'const MEMKEY ='),
  section('let lastSeq =', '// ---- AES-128'),
  section('let lastTempC =', 'function pushBatch('),
  section('function qPlausible(', 'async function bulkCmd('),
  section('function decodePdo(', '// ---- WebSerial'),
  section('let port =', '// ---- WebHID'),
  section('async function pdPollOnce()', 'let lowSince ='),
  section('const PD_REV =', 'function decodePdPayload('),
].join('\n');
function assert(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
const bytes = s => Uint8Array.from(s, c => c.charCodeAt(0));
function harness() {
  let mono = 0, wall = 100000, nextId = 1;
  const timers = new Map(), logs = [], nodes = {}, exports = [];
  const node = id => nodes[id] ||= { checked: true, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, addEventListener() {}, setAttribute() {} };
  const env = {
    Date: class extends Date { static now() { return wall; } },
    performance: { now: () => mono },
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: mono + ms, fn }); return id; },
    clearTimeout: id => timers.delete(id),
    TextEncoder: class { encode(s) { return bytes(s); } },
    TextDecoder: class { decode(value = []) { return Array.from(value, b => String.fromCharCode(b)).join(''); } },
    document: { getElementById: node },
    navigator: { serial: { requestPort: async () => env.nextPort } },
    log: (...args) => logs.push(args.join(' ')),
    downloadCsv: (name, text) => exports.push({ name, text }),
  };
  const api = new Function('env', `
    const {Date, performance, setTimeout, clearTimeout, TextEncoder, TextDecoder, document, navigator, log, downloadCsv} = env;
    const hist = [], IDIR_T = 0.005;
    let usb = null, pdTid = 150, pdmHeld = false, mismatchSince = 0;
    const usbExcl = fn => fn(), pushBatch = items => hist.push(...items), paintLive = () => {};
    const sliceBuf = dv => dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength);
    const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(' ');
    const clearContract = () => { pdos.length = 0; wirePdo = 0; };
    ${dataSource}
    return {
      replacePdoDecoded, feedPd, feedPdBinary, resetSerialPd, ingestBatch, sniffContract,
      table: () => pdos.slice(), history: () => hist.slice(), stats: () => ({ dropped, corrupt }),
      seedHistory: t => hist.push({ t }), setLatch: n => { wirePdo = n; }, latch: () => wirePdo,
      setPort: p => { port = p; }, write: serWrite, query: () => document.getElementById('serPdm').onclick(),
      connect: () => document.getElementById('serConnect').onclick(),
      exportPdos: () => document.getElementById('pdCsv').onclick(),
      poll: pdPollOnce, setUsb: d => { usb = d; }, pendingText: () => serText.length
    };
  `)(env);
  async function drive(promise) {
    let done = false, value, error;
    promise.then(v => { done = true; value = v; }, e => { done = true; error = e; });
    for (let turn = 0; !done && turn < 200; turn++) {
      for (let i = 0; i < 64; i++) await Promise.resolve();
      if (done) break;
      const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) throw new Error('Unsettled promise with no timer');
      timers.delete(first[0]); wall += first[1].at - mono; mono = first[1].at; first[1].fn();
    }
    if (!done) throw new Error('Test did not settle');
    if (error) throw error;
    return value;
  }
  return { api, env, drive, node, timers, logs, exports, advance: (ms, wallMs = ms) => { mono += ms; wall += wallMs; } };
}
function serialDevice(onWrite = () => {}) {
  let locked = false;
  const commands = [], device = {
    commands, writable: { getWriter() {
      assert(!locked, 'Serial writers cannot overlap'); locked = true;
      return {
        write(buffer) { const command = Array.from(buffer, b => String.fromCharCode(b)).join('').trim(); commands.push(command); return Promise.resolve().then(() => onWrite(command)); },
        releaseLock() { locked = false; },
      };
    } },
    async open() {},
  };
  return device;
}
const fixed = (v, a = 3) => ({ t: 'Fixed', v, a });
const pps = (lo, hi, a = 3) => ({ t: 'PPS', v: hi, a, pps: [lo, hi] });
const fixedWord = (v, a = 3) => (Math.round(v / 0.05) << 10) | Math.round(a / 0.01);
function binaryPdos(words) {
  const data = new Uint8Array(6 + words.length * 4); data.set(bytes(`pdo:${words.length},`));
  words.forEach((word, i) => new DataView(data.buffer).setUint32(6 + i * 4, word, true));
  return data;
}
function pdPacket(records) {
  const frames = records.map(record => {
    const words = record.words || [record.req << 28], type = record.words ? 1 : 2;
    const wire = new Uint8Array(2 + words.length * 4), view = new DataView(wire.buffer);
    view.setUint16(0, type | (2 << 6) | (words.length << 12), true);
    words.forEach((word, i) => view.setUint32(2 + i * 4, word, true));
    const frame = new Uint8Array(6 + wire.length); frame[0] = wire.length + 5; frame.set(wire, 6); return frame;
  });
  const data = new Uint8Array(20 + frames.reduce((n, frame) => n + frame.length, 0));
  data[0] = 0xC1; new DataView(data.buffer).setUint32(4, 0x010 | ((data.length - 8) << 22), true);
  let offset = 20; for (const frame of frames) { data.set(frame, offset); offset += frame.length; }
  return data.buffer;
}
const sample = (seq, vbus = 5) => ({ seq, vbus, ibusSigned: 1, vcc1: 0, vcc2: 0, vdp: 0, vdm: 0 });
async function runTests() {
  const passed = [];
  async function test(name, fn) { await fn(); passed.push(name); }
  await test('query failures at every command attempt PDM cleanup', async () => {
    for (const failing of ['pdm open', 'entry pd', 'pd pdo']) {
      const { api, drive, node, timers } = harness();
      const device = serialDevice(command => { if (command === failing) throw Error(`failed ${failing}`); }); api.setPort(device);
      await drive(api.query());
      equal(device.commands.at(-1), 'pdm close', `Cleanup after ${failing}`);
      assert(node('serStat').textContent.includes(`failed ${failing}`) && node('serStat').textContent.includes('pdm closed'), 'Original error and cleanup result shown');
      assert(!node('serPdm').disabled && timers.size === 0, 'Button restored and write timeouts cleared');
    }
  });
  await test('failed queries close PDM with auto-exit off; successful queries retain it', async () => {
    for (const fail of [true, false]) {
      const { api, drive, node } = harness(); node('serPdmAuto').checked = false;
      const device = serialDevice(command => { if (fail && command === 'pd pdo') throw Error('query failed'); }); api.setPort(device);
      await drive(api.query());
      equal(device.commands.includes('pdm close'), fail, 'Keep PDM only after a successful query');
    }
  });
  await test('failed PDM cleanup remains visible without claiming the session closed', async () => {
    const { api, drive, node } = harness(); api.setPort(serialDevice(() => { throw Error('device unavailable'); }));
    await drive(api.query());
    assert(node('serStat').textContent.includes('may still be open'), 'Failed cleanup is explicit');
    assert(!node('serStat').textContent.includes('pdm closed'), 'Do not claim release without a successful write');
  });
  await test('timed-out serial writes release their writer and attempt query cleanup', async () => {
    const { api, drive, timers, node } = harness();
    const device = serialDevice(command => command === 'entry pd' ? new Promise(() => {}) : undefined); api.setPort(device);
    await drive(api.query());
    equal(device.commands, ['pdm open', 'entry pd', 'pdm close'], 'Cleanup follows timeout');
    assert(node('serStat').textContent.includes('timed out') && timers.size === 0, 'Timeout reported and timers cleared');
  });
  await test('a query cannot continue on or close a replacement serial connection', async () => {
    const { api, drive, node } = harness(), replacement = serialDevice();
    const original = serialDevice(command => { if (command === 'pdm open') api.setPort(replacement); }); api.setPort(original);
    await drive(api.query());
    equal(replacement.commands, [], 'No commands sent to the replacement port');
    assert(node('serStat').textContent.includes('may still be open'), 'Old session cleanup could not be confirmed');
  });
  await test('serial text split at every byte keeps Fixed and PPS PDOs in order', async () => {
    const text = 'pdo:4,Fixed: 5.00V 3.00A\r\nPPS: 3.3-11.0V 2.00A\r\nFixed: 9.00V 2.00A\r\nPPS: 5.0-11.0V 3.00A';
    const expected = [fixed(5), pps(3.3, 11, 2), fixed(9, 2), pps(5, 11)];
    for (let split = 0; split <= text.length; split++) {
      const { api } = harness(); api.feedPd(text.slice(0, split)); api.feedPd(text.slice(split));
      equal(api.table(), expected, `Text split at ${split}`);
    }
    const { api } = harness(); for (const char of text) api.feedPd(char);
    equal(api.table(), expected, 'One-byte reads, including a final token without newline');
  });
  await test('serial reader passes fragmented text through the persistent parser', async () => {
    const { api, env, drive } = harness(), text = 'pdo:2,Fixed: 5.00V 3.00A\nFixed: 9.00V 2.00A\n';
    const device = serialDevice(); let offset = 0, ended;
    const finished = new Promise(resolve => { ended = resolve; });
    device.readable = { getReader: () => ({
      async read() { if (offset < text.length) return { value: bytes(text[offset++]), done: false }; device.readable = null; ended(); return { done: true }; },
      releaseLock() {},
    }) };
    env.nextPort = device; await drive(api.connect()); await drive(finished);
    equal(api.table(), [fixed(5), fixed(9, 2)], 'Full serial read path reassembles each line');
  });
  await test('large serial reads process complete messages before bounding their unmatched suffix', async () => {
    const { api } = harness();
    api.feedPd('pdo:2,Fixed: 5.00V 3.00A Fixed: 9.00V 2.00A' + 'x'.repeat(5000));
    equal(api.table(), [fixed(5), fixed(9, 2)], 'Leading text table in a large read retained');
    assert(api.pendingText() <= 4096, 'Unmatched text stays bounded');
    const frame = binaryPdos([fixedWord(5), fixedWord(20)]), large = new Uint8Array(frame.length + 5000);
    large.set(frame); api.feedPdBinary(large);
    equal(api.table(), [fixed(5), fixed(20)], 'Leading binary table in a large read retained');
  });
  await test('new capability snapshots replace old slots, preserving duplicates and PDO padding', async () => {
    const { api, exports } = harness(); api.replacePdoDecoded([fixed(5), fixed(9), fixed(20)], 'first'); api.setLatch(2);
    assert(api.replacePdoDecoded([fixed(5), fixed(9, 2)], 'second'), 'Changed snapshot detected');
    equal(api.table(), [fixed(5), fixed(9, 2)], 'PDO2 changed, obsolete PDO3 removed'); equal(api.latch(), 0, 'Old request mapping invalidated');
    const padded = [fixed(5), fixed(5), { t: 'Pad', v: 0, a: null }, fixed(20)];
    api.replacePdoDecoded(padded, 'padded'); equal(api.table(), padded, 'Duplicate and padding slots retained');
    api.exportPdos(); const lines = exports[0].text.trim().split('\n');
    equal(lines.slice(1).map(line => +line.split(',')[0]), [1, 2, 4], 'CSV keeps original PDO indexes');
  });
  await test('identical or malformed snapshots do not invalidate a good table or request', async () => {
    const { api } = harness(), original = [fixed(5), pps(3.3, 11, 2)]; api.replacePdoDecoded(original, 'first'); api.setLatch(2);
    assert(!api.replacePdoDecoded([fixed(5), pps(3.3, 11, 2)], 'same'), 'Repeated table unchanged');
    assert(!api.replacePdoDecoded([fixed(5), fixed(0.2)], 'corrupt'), 'Malformed message rejected whole');
    equal(api.table(), original, 'Original table retained'); equal(api.latch(), 2, 'Request retained for unchanged table');
    assert(api.replacePdoDecoded([fixed(5), pps(5, 11, 2)], 'range changed'), 'Different PPS minimum is a changed PDO');
  });
  await test('binary PDO frames tolerate every split and retain a following partial frame', async () => {
    const frame = binaryPdos([fixedWord(5), fixedWord(9, 2)]);
    for (let split = 0; split <= frame.length; split++) {
      const { api } = harness(); api.feedPdBinary(frame.slice(0, split)); api.feedPdBinary(frame.slice(split));
      equal(api.table(), [fixed(5), fixed(9, 2)], `Binary split at ${split}`);
    }
    const { api } = harness(), next = binaryPdos([fixedWord(5), fixedWord(20)]), joined = new Uint8Array(frame.length + 8);
    joined.set(frame); joined.set(next.slice(0, 8), frame.length); api.feedPdBinary(joined); api.feedPdBinary(next.slice(8));
    equal(api.table(), [fixed(5), fixed(20)], 'Later frame replaces the first snapshot');
  });
  await test('wire snapshots preserve PDO slots and process Request ordering', async () => {
    const { api } = harness();
    async function poll(records) { const buffer = pdPacket(records); api.setUsb({ async transferOut() {}, async transferIn() { return { data: new DataView(buffer) }; } }); await api.poll(); }
    await poll([{ words: [fixedWord(5), fixedWord(9)] }, { req: 2 }]); equal(api.latch(), 2, 'Request after Source_Cap latched');
    await poll([{ req: 2 }, { words: [fixedWord(5), fixedWord(9, 2)] }]); equal(api.latch(), 0, 'Request before changed Source_Cap is stale');
    await poll([{ words: [fixedWord(5), 0, fixedWord(20)] }, { req: 3 }]);
    equal(api.table()[2], fixed(20), 'PDO3 remains PDO3 across padding'); equal(api.latch(), 3, 'Fresh request maps to the latest table');
  });
  await test('stream timing is continuous across rapid and delayed batches', async () => {
    const { api, advance } = harness(); api.ingestBatch(Array.from({ length: 10 }, (_, i) => sample(i)), 3);
    advance(1); api.ingestBatch(Array.from({ length: 10 }, (_, i) => sample(i + 10)), 3);
    advance(200); api.ingestBatch([sample(20), sample(21)], 3);
    const history = api.history();
    assert(history.every((p, i) => !i || p.t - history[i - 1].t === 1), 'Polling latency cannot overlap or stretch device samples');
  });
  await test('stream sample gaps and u16 wrap retain device elapsed milliseconds', async () => {
    const { api } = harness(); api.ingestBatch([sample(65534), sample(65535), sample(0), sample(10)], 3);
    equal(api.history().map(p => p.t - api.history()[0].t), [0, 1, 2, 12], 'Wrap and dropped-sample gap'); equal(api.stats().dropped, 9, 'Missing samples counted');
  });
  await test('duplicates, replays, and corrupt frames cannot poison stream time', async () => {
    const { api, advance } = harness(); api.ingestBatch([sample(10), sample(11)], 3); advance(1);
    api.ingestBatch([sample(10), sample(11), sample(12, 100), sample(13)], 3);
    equal(api.history().map(p => p.t - api.history()[0].t), [0, 1, 3], 'Only forward valid samples accepted, with skipped time retained');
  });
  await test('stream clock honors slower device rates and retained history', async () => {
    const { api } = harness(); api.seedHistory(100010); api.ingestBatch([sample(100), sample(200)], 1);
    const history = api.history(); assert(history[1].t > history[0].t, 'New stream follows retained single-shot history');
    equal(history[2].t - history[1].t, 100, '10 SPS uses device milliseconds');
  });
  await test('long silences reanchor ambiguous counters without moving history backward', async () => {
    const { api, advance } = harness(); api.ingestBatch([sample(100)], 3); const first = api.history()[0].t;
    advance(40000); api.ingestBatch([sample(40100)], 3); equal(api.history()[1].t - first, 40000, 'Long gap reanchored to receipt time');
    advance(40000, -50000); api.ingestBatch([sample(14564)], 3);
    assert(api.history()[2].t > api.history()[1].t, 'Host clock rollback cannot reverse retained history');
  });
  return passed;
}
runTests().then(passed => {
  globalThis.DATA_TEST_RESULT = { passed };
  if (typeof console !== 'undefined') console.log(`${passed.length} checks passed\n${passed.join('\n')}`);
}, error => {
  globalThis.DATA_TEST_RESULT = { error: String(error) + (error.stack ? '\n' + error.stack : '') };
  if (typeof console !== 'undefined') console.error(error);
  if (typeof process !== 'undefined') process.exitCode = 1;
});
