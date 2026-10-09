// Run with: node tests/stream.test.js. APP_SOURCE also allows an embedded JS runtime.
const appSource = typeof require === 'function'
  ? require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8')
  : APP_SOURCE;
const appScript = appSource.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(appScript); // Parse the entire application, including code outside the harness.
function section(from, to) {
  const start = appScript.indexOf(from), end = appScript.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`Missing application section: ${from}`);
  return appScript.slice(start, end);
}
const protocol = [
  section('let usbChain =', "document.getElementById('usbConnect')"),
  section('let streamClosing =', 'function stopLive()'),
  section('const MEMKEY =', 'function parseQueue('),
  section('async function bulkCmd(', 'async function startStream('),
].join('\n');
function harness() {
  let now = 0, nextId = 1;
  const timers = new Map(), logs = [];
  const env = {
    log: (...args) => logs.push(args.join(' ')),
    performance: { now: () => now },
    crypto: { getRandomValues: bytes => bytes.fill(0x5a) },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: id => timers.delete(id),
    btoa: () => '', atob: () => '',
  };
  const api = new Function('env', `
    const {log, performance, crypto, localStorage, setTimeout, clearTimeout, btoa, atob} = env;
    let usb = null, claimed = false, pdMon = false, pdTid = 150;
    const sliceBuf = dv => dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength);
    const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(' ');
    ${protocol}
    return {
      parseAuthReply, readBulkBytes, tryAuth, streamAuth, bulkCmd, streamTeardown, usbExcl,
      aesSelfTest, ecbCrypt, crc32,
      setDevice: d => { usb = d; }, getDevice: () => usb,
      closing: () => streamClosing, chain: () => usbChain
    };
  `)(env);
  async function drive(promise) {
    let done = false, value, error;
    promise.then(v => { done = true; value = v; }, e => { done = true; error = e; });
    for (let turn = 0; !done && turn < 200; turn++) {
      // Drain promise continuations before advancing to the next timer.
      for (let i = 0; i < 64; i++) await Promise.resolve();
      if (done) break;
      const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) throw new Error('Unsettled promise with no timer');
      timers.delete(first[0]); now = first[1].at; first[1].fn();
    }
    if (!done) throw new Error('Test did not settle');
    if (error) throw error;
    return value;
  }
  return { api, drive, env, logs, timers };
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
function authReply(raw) {
  const bytes = new Uint8Array(36);
  bytes.set([0x4c, 0, raw & 255, raw >>> 8]);
  return bytes;
}
function result(bytes) {
  // Offset DataViews exercise the browser's transferIn shape.
  const padded = new Uint8Array(bytes.length + 3); padded.set(bytes, 3);
  return { status: 'ok', data: new DataView(padded.buffer, 3, bytes.length) };
}
function device(chunks = [], productId = 0x63) {
  return {
    opened: true, productId, serialNumber: '022386', writes: [], closes: 0,
    async transferOut(ep, bytes) { this.writes.push([...new Uint8Array(bytes)]); return { status: 'ok' }; },
    async transferIn() {
      if (!chunks.length) throw new Error('Unexpected extra USB read');
      return result(chunks.shift());
    },
    async close() { this.closes++; this.opened = false; },
  };
}
async function runTests() {
  const passed = [];
  async function test(name, fn) { await fn(); passed.push(name); }
  await test('KM003C and KM002C grants/refusals use different raw bits', async () => {
    const { api } = harness();
    for (const [pid, raw, level] of [[0x63, 0x0201, 0], [0x63, 0x0203, 1],
      [0x63, 0x0202, 0], [0x61, 0x0202, 0], [0x61, 0x0204, 1]]) {
      equal(api.parseAuthReply(authReply(raw).buffer, pid).level, level, `pid ${pid}, raw ${raw}`);
    }
    for (const invalid of [new Uint8Array(20), new Uint8Array(36)]) {
      let threw = false;
      try { api.parseAuthReply(invalid.buffer, 0x63); } catch (_) { threw = true; }
      assert(threw, 'Malformed auth reply must fail');
    }
    assert(api.aesSelfTest(), 'Existing AES vectors must pass');
  });
  await test('fragmented authentication with empty transfers sends one request', async () => {
    const { api, drive } = harness(), reply = authReply(0x0203);
    const d = device([new Uint8Array(0), reply.slice(0, 16), new Uint8Array(0), reply.slice(16)]);
    api.setDevice(d);
    equal(await drive(api.tryAuth(new Uint8Array(12), 'HWID')), 1, 'Auth level');
    equal(d.writes.length, 1, 'Do not resend after an empty transfer');
  });
  await test('a complete refusal is returned without resending', async () => {
    const { api, drive } = harness(), d = device([authReply(0x0201)]);
    api.setDevice(d);
    equal(await drive(api.tryAuth(new Uint8Array(12), 'HWID')), 0, 'Refused level');
    equal(d.writes.length, 1, 'Parsed refusal is a real answer');
  });
  await test('auth requests are spaced at least one second apart', async () => {
    const { api, drive, env } = harness(), d = device([authReply(0x0203), authReply(0x0203)]), sent = [];
    d.transferOut = async function(ep, bytes) { sent.push(env.performance.now()); this.writes.push([...new Uint8Array(bytes)]); };
    api.setDevice(d);
    await drive(api.tryAuth(new Uint8Array(12), 'first'));
    await drive(api.tryAuth(new Uint8Array(12), 'second'));
    assert(sent[1] - sent[0] >= 1000, 'Firmware throttle interval');
    assert(d.writes[0][1] !== d.writes[1][1], 'New requests have new ids');
  });
  await test('reported KM003C HWID reply reaches START_GRAPH without calibration reads', async () => {
    const { api, drive } = harness();
    const hwid = Uint8Array.from('3139384834500aff0e6dffff'.match(/../g).map(h => parseInt(h, 16)));
    const memory = new Uint8Array(36), view = new DataView(memory.buffer);
    memory.set([0xc4, 150, 1, 1]);
    view.setUint32(4, 0x40010450, true); view.setUint32(8, 12, true);
    view.setUint32(12, 0xffffffff, true); view.setUint32(16, api.crc32(memory.slice(4, 16)), true);
    const plain = new Uint8Array(16); plain.set(hwid);
    memory.set(await api.ecbCrypt(Uint8Array.from('Lh2yfB7n6X7d9a5Z', c => c.charCodeAt(0)), plain, 'encrypt'), 20);
    const reported = Uint8Array.from(('4c000302492d2188e92ab7fe241ba37bf25ba8fb' +
      '1e01f2d64292205caafc65ccb4bcfea5').match(/../g).map(h => parseInt(h, 16)));
    const d = device([memory.slice(0, 20), memory.slice(20), reported, new Uint8Array([5, 152, 0, 0])]);
    api.setDevice(d);
    equal(await drive(api.streamAuth()), 1, 'Reported HWID grant');
    equal(await drive(api.bulkCmd('START_GRAPH', [0x0e, 0, 6, 0])), 5, 'Graph accepted');
    equal(d.writes.map(w => w[0]), [0x44, 0x4c, 0x0e], 'Only HWID read, auth, start');
  });
  await test('control replies tolerate fragmentation and verify transaction id', async () => {
    const { api, drive } = harness(), d = device([new Uint8Array([5, 150]), new Uint8Array([0, 0]), new Uint8Array([5, 99, 0, 0])]);
    api.setDevice(d);
    equal(await drive(api.bulkCmd('CONNECT', [2, 0, 0, 0])), 5, 'Fragmented ACCEPT');
    let error;
    try { await drive(api.bulkCmd('CONNECT', [2, 0, 0, 0])); } catch (e) { error = e; }
    assert(error && /mismatched reply id/.test(error.message), 'Stale reply must fail');
  });
  await test('USB stalls and oversized encrypted replies fail explicitly', async () => {
    for (const kind of ['stall', 'oversized']) {
      const { api, drive } = harness(), d = device([new Uint8Array(40)]);
      if (kind === 'stall') d.transferIn = async () => ({ status: 'stall' });
      api.setDevice(d);
      let error;
      try { await drive(api.usbExcl(() => api.readBulkBytes(d, 36, 'STREAM_AUTH'))); } catch (e) { error = e; }
      assert(error && error.message.includes(kind === 'stall' ? 'stall' : 'oversized'), `${kind} should fail`);
    }
  });
  await test('timeout closes a hung transfer and rejects queued stale jobs', async () => {
    const { api, drive, timers } = harness(), d = device();
    let abort, queued = false;
    d.transferIn = () => new Promise((resolve, reject) => { abort = reject; });
    d.close = async function() { this.closes++; this.opened = false; abort(new Error('Transfer cancelled')); };
    api.setDevice(d);
    const first = api.usbExcl(() => d.transferIn(1, 64), 50);
    const second = api.usbExcl(() => { queued = true; }, 50);
    const outcomes = await drive(Promise.allSettled([first, second]));
    assert(outcomes.every(r => r.status === 'rejected'), 'Both stale jobs fail');
    assert(outcomes[0].reason.message.includes('USB timeout'), 'Timeout reported');
    equal(d.closes, 1, 'Handle closed once'); assert(!queued, 'Queued stale callback not run');
    equal(api.getDevice(), null, 'Timed-out handle dropped');
    await drive(api.chain());
    api.setDevice(device());
    equal(await drive(api.usbExcl(() => 42)), 42, 'Fresh handle works');
    equal(timers.size, 0, 'No timeout left to interrupt a later operation');
  });
  await test('a queued job gets its full timeout when it starts', async () => {
    const { api, drive, env } = harness(); api.setDevice(device());
    const delayed = (ms, value) => new Promise(resolve => env.setTimeout(() => resolve(value), ms));
    const first = api.usbExcl(() => delayed(30, 1), 100);
    const second = api.usbExcl(() => delayed(5, 2), 20);
    equal(await drive(Promise.all([first, second])), [1, 2], 'Queue wait does not consume timeout');
  });
  await test('STOP_GRAPH and DISCONNECT finish before a new CONNECT', async () => {
    const { api, drive } = harness();
    const d = device([new Uint8Array([5, 150, 0, 0]), new Uint8Array([5, 151, 0, 0]), new Uint8Array([5, 152, 0, 0])]);
    api.setDevice(d);
    api.streamTeardown();
    await drive((async () => { await api.closing(); await api.bulkCmd('CONNECT', [2, 0, 0, 0]); })());
    equal(d.writes.map(w => w[0]), [15, 3, 2], 'Teardown order');
  });
  return passed;
}
runTests().then(passed => {
  globalThis.STREAM_TEST_RESULT = { passed };
  if (typeof console !== 'undefined') console.log(`${passed.length} checks passed\n${passed.join('\n')}`);
}, error => {
  globalThis.STREAM_TEST_RESULT = { error: String(error.stack || error) };
  if (typeof console !== 'undefined') console.error(error);
  if (typeof process !== 'undefined') process.exitCode = 1;
});
