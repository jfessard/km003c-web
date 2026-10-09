// Run with: node tests/graph.test.js. APP_SOURCE supports an embedded JS runtime.
const appSource = typeof require === 'function'
  ? require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8')
  : APP_SOURCE;
const appScript = appSource.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(appScript);
const graphSource = appScript.slice(appScript.indexOf('const GCOL ='), appScript.indexOf('function clearOverlay()'));
const zoomSource = appScript.slice(appScript.indexOf('function panGraph('), appScript.indexOf('// hover crosshair with exact'));
function assert(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
function canvas() {
  return {
    paths: [], commands: [],
    beginPath() { this.commands = []; },
    moveTo(x, y) { this.commands.push(['M', x, y]); },
    lineTo(x, y) { this.commands.push(['L', x, y]); },
    stroke() { this.paths.push(this.commands.slice()); },
    setTransform() {}, clearRect() {}, fillRect() {}, fillText() {},
  };
}
function harness() {
  const ctx = canvas(), nodes = {}, handlers = {};
  for (const id of ['gV', 'gI', 'gP', 'gCC1', 'gCC2', 'gDP', 'gDM', 'gZero']) nodes[id] = { checked: id === 'gV' || id === 'gZero' };
  nodes.graphWindow = { value: '30' }; nodes.graphLegend = {}; nodes.graphStat = {};
  nodes.graph = { clientWidth: 1000, clientHeight: 220, getContext: () => ctx };
  nodes.graphWrap = { getBoundingClientRect: () => ({ left: 0 }), addEventListener: (event, fn) => { handlers[event] = fn; } };
  const api = new Function('nodes', `
    const hist = [], window = { devicePixelRatio: 1 }, performance = { now: () => 0 };
    let liveTimer = null, streamOn = false, liveStarting = false;
    const document = { getElementById: id => nodes[id] };
    function clearOverlay() {} function drawOverlay() {}
    ${graphSource}
    ${zoomSource}
    return {
      drawTrace, drawGraph, yTicks, plot: () => lastPlot,
      setHistory: points => { hist.splice(0, hist.length, ...points); },
      historySize: () => hist.length,
      setCapture: mode => { streamOn = mode === 'stream'; liveTimer = mode === 'poll' ? 1 : null; },
      wheel: (x, deltaY, options) => nodes.graphWrap.wheel(x, deltaY, options),
      timeAt: x => lastPlot.t1 - (1 - (x - lastPlot.padL) / lastPlot.iw) * lastPlot.spanMs
    };
  `)(nodes);
  nodes.graphWrap.wheel = (clientX, deltaY, options = {}) => handlers.wheel({ clientX, deltaY, preventDefault() {}, ...options });
  return { api, ctx, nodes };
}
function runTests() {
  const passed = [];
  function test(name, fn) { fn(); passed.push(name); }
  test('sparse readings retain their exact polyline', () => {
    const { api, ctx } = harness(), data = [{ t: 0, v: 5 }, { t: 50, v: 4 }, { t: 100, v: 5 }];
    api.drawTrace(ctx, data, 'v', t => t / 10, v => v, 0, 10);
    equal(ctx.paths[0], [['M', 0, 5], ['L', 5, 4], ['L', 10, 5]], 'Sparse path');
  });
  test('adding 1000 SPS data keeps older sparse history connected', () => {
    const { api, ctx } = harness();
    const sparse = Array.from({ length: 25 }, (_, i) => ({ t: i * 1000, v: 5 }));
    const dense = Array.from({ length: 8000 }, (_, i) => ({ t: 25000 + i, v: 4 + i % 2 }));
    const data = sparse.concat(dense), before = JSON.stringify(data), X = t => t / 33;
    api.drawTrace(ctx, data, 'v', X, v => v, 0, 1000);
    equal(ctx.paths[0].slice(0, 25), sparse.map((p, i) => [i ? 'L' : 'M', X(p.t), p.v]), 'Sparse prefix still connected');
    equal(JSON.stringify(data), before, 'All raw samples preserved');
    assert(ctx.paths[0].filter(c => c[0] === 'M').length === 1, 'Connected trace has one starting point');
  });
  test('dense columns preserve an interior spike and dip', () => {
    const { api, ctx } = harness();
    const data = Array.from({ length: 1000 }, (_, i) => ({ t: i, v: 5 }));
    data[455].v = 20; data[456].v = 1;
    api.drawTrace(ctx, data, 'v', t => t / 100, v => v, 0, 10);
    const envelope = ctx.paths[1];
    assert(envelope.some((p, i) => p[0] === 'M' && p[1] === 4.5 && p[2] === 20 &&
      envelope[i + 1][0] === 'L' && envelope[i + 1][2] === 1), 'Both extrema in the same pixel are visible');
  });
  test('a flat dense signal draws a continuous line', () => {
    const { api, ctx } = harness(), data = Array.from({ length: 1000 }, (_, i) => ({ t: i, v: 5 }));
    api.drawTrace(ctx, data, 'v', t => t / 100, v => v, 0, 10);
    assert(ctx.paths[0].length > 1, 'Flat data draws a line');
    assert(ctx.paths[0].every(p => p[2] === 5), 'Flat line stays flat');
    equal(ctx.paths[1], [], 'No zero-height envelope strokes needed');
  });
  test('rendering 60000 samples uses at most four drawing commands per column', () => {
    const { api, ctx } = harness(), cols = 800;
    const data = Array.from({ length: 60000 }, (_, i) => ({ t: i, v: 4 + i % 7 / 10 }));
    api.drawTrace(ctx, data, 'v', t => t * cols / 60000, v => v, 0, cols);
    assert(ctx.paths.flat().length <= 4 * cols, 'Drawing complexity scales with canvas width');
  });
  test('scrolling through the density threshold keeps both ends of the trace', () => {
    for (const count of [600, 601]) {
      const { api, ctx } = harness(), data = Array.from({ length: count }, (_, i) => ({ t: i, v: 5 }));
      api.drawTrace(ctx, data, 'v', t => t * 100 / count, v => v, 0, 100);
      equal(ctx.paths[0][0], ['M', 0, 5], `First sample at ${count}`);
      equal(ctx.paths[0].at(-1), ['L', (count - 1) * 100 / count, 5], `Last sample at ${count}`);
    }
  });
  test('live axis limits expand in steps without easing on redraws', () => {
    const { api } = harness();
    api.setCapture('stream'); api.setHistory([{ t: 100000, vbus: 5.1 }]); api.drawGraph();
    equal(api.plot().lim.vbus, [0, 6], '5.1V uses the smallest voltage range');
    for (let i = 1; i <= 30; i++) {
      api.setHistory([{ t: 100000 + i * 1000, vbus: 5.1 + i % 2 * 0.1 }]); api.drawGraph();
      equal(api.plot().lim.vbus, [0, 6], 'Minor changes and redraws keep the same range');
    }
    api.setHistory([{ t: 131000, vbus: 9.1 }]); api.drawGraph();
    equal(api.plot().lim.vbus, [0, 10], 'A new rail expands the axis immediately');
  });
  test('voltage ranges fit SPR, legacy/intermediate rails, and EPR with headroom', () => {
    for (const [volts, top] of [[5.1, 6], [9.2, 10], [12.2, 13], [15.2, 16], [20.2, 21], [24.2, 26], [28.2, 30], [36.2, 38], [48.2, 51], [60, 65]]) {
      const { api } = harness(); api.setHistory([{ t: 100000, vbus: volts }]); api.drawGraph();
      equal(api.plot().lim.vbus, [0, top], `Range for ${volts}V`);
    }
  });
  test('normal +5 percent rail tolerance does not force a larger voltage range', () => {
    for (const [nominal, top] of [[5, 6], [9, 10], [12, 13], [15, 16], [20, 21], [24, 26], [28, 30], [36, 38], [48, 51]]) {
      const { api } = harness(); api.setHistory([{ t: 100000, vbus: nominal * 1.05 }]); api.drawGraph();
      equal(api.plot().lim.vbus, [0, top], `${nominal}V at its normal tolerance limit`);
    }
  });
  test('current and power use independent steps, including small currents', () => {
    const { api, nodes } = harness(); nodes.gI.checked = true; nodes.gP.checked = true;
    api.setHistory([{ t: 100000, vbus: 5.1, ibus: 0.12, pwr: 0.612 }]); api.drawGraph();
    equal(api.plot().lim, { vbus: [0, 6], ibus: [0, 0.2], pwr: [0, 1] }, 'Each unit has its own useful range');
  });
  test('zoom and pan retain every axis even when a peak is outside the visible window', () => {
    for (const zero of [true, false]) {
      const { api, nodes } = harness(); nodes.gI.checked = true; nodes.gP.checked = true; nodes.gZero.checked = zero;
      const points = Array.from({ length: 601 }, (_, i) => ({ t: 100000 + i * 100, vbus: 5.1, ibus: 0.12, pwr: 0.612 }));
      points[10] = { t: 101000, vbus: 20.2, ibus: 4.8, pwr: 96.96 };
      api.setHistory(points); api.drawGraph();
      const ranges = JSON.stringify(api.plot().lim), plot = api.plot(), x = plot.padL + plot.iw * 0.7;
      for (let i = 0; i < 8; i++) {
        api.wheel(x, -100); equal(JSON.stringify(api.plot().lim), ranges, 'Zoom leaves all Y ranges unchanged');
      }
      for (const deltaX of [-100, -10000, 100, 10000]) {
        api.wheel(x, 0, { deltaX }); equal(JSON.stringify(api.plot().lim), ranges, 'Panning leaves all Y ranges unchanged');
      }
    }
  });
  test('live scales shrink only after 15 seconds of sustained lower history', () => {
    const { api } = harness(); api.setCapture('stream');
    api.setHistory([{ t: 100000, vbus: 20.2 }]); api.drawGraph();
    for (let i = 0; i < 15; i++) {
      api.setHistory([{ t: 101000 + i * 1000, vbus: 5.1 }]); api.drawGraph();
      equal(api.plot().lim.vbus, [0, 21], 'No early shrink after higher data leaves the history buffer');
    }
    api.setHistory([{ t: 116000, vbus: 5.1 }]); api.drawGraph();
    equal(api.plot().lim.vbus, [0, 6], 'Sustained lower data changes directly to the smaller step');
  });
  test('scale hysteresis resets on boundary noise, pause, and capture gaps', () => {
    const { api } = harness(); api.setCapture('stream');
    api.setHistory([{ t: 100000, vbus: 15.2 }]); api.drawGraph();
    for (let i = 1; i <= 40; i++) {
      api.setHistory([{ t: 100000 + i * 1000, vbus: i % 10 === 0 ? 13.1 : 12.2 }]); api.drawGraph();
      equal(api.plot().lim.vbus, [0, 16], 'Boundary noise prevents oscillation');
    }
    api.setHistory([{ t: 141000, vbus: 5.1 }]); api.drawGraph();
    api.setCapture('paused'); api.setHistory([{ t: 200000, vbus: 5.1 }]); api.drawGraph();
    equal(api.plot().lim.vbus, [0, 16], 'Paused graph holds its scale');
    api.setCapture('stream'); api.drawGraph();
    equal(api.plot().lim.vbus, [0, 16], 'Resuming does not count the pause toward shrink time');
    api.setHistory([{ t: 230000, vbus: 5.1 }]); api.drawGraph();
    equal(api.plot().lim.vbus, [0, 16], 'A gap without samples restarts shrink timing');
  });
  test('hidden series keep their scale and Clear allows a fresh smaller range', () => {
    const { api, nodes } = harness();
    api.setHistory([{ t: 100000, vbus: 20.2 }]); api.drawGraph();
    nodes.gV.checked = false; api.drawGraph();
    api.setHistory([{ t: 101000, vbus: 5.1 }]); nodes.gV.checked = true; api.drawGraph();
    equal(api.plot().lim.vbus, [0, 21], 'Visibility changes do not discard the scale');
    api.setHistory([]); api.drawGraph();
    api.setHistory([{ t: 102000, vbus: 5.1 }]); api.drawGraph();
    equal(api.plot().lim.vbus, [0, 6], 'Clearing history resets the scale');
  });
  test('voltage axis labels include the actual stepped ceiling', () => {
    const { api } = harness();
    for (const top of [6, 10, 13, 16, 21, 26, 30, 38, 51, 65]) {
      const ticks = api.yTicks(0, top);
      equal(ticks.at(-1).v, top, 'Ceiling is explicitly labelled');
      equal(+ticks.at(-1).lbl, top, 'Label shows the true range');
    }
  });
  test('paused zoom keeps -13.8s under the cursor with less than 30s of history', () => {
    const { api } = harness(), end = 100000;
    api.setHistory(Array.from({ length: 141 }, (_, i) => ({ t: end - 14000 + i * 100, vbus: 5 })));
    api.drawGraph();
    const plot = api.plot(), x = plot.padL + plot.iw * (1 - 13800 / plot.spanMs);
    const target = api.timeAt(x);
    for (let i = 0; i < 2; i++) {
      api.wheel(x, -100);
      assert(Math.abs(api.timeAt(x) - target) < 1e-6, 'Zoom preserves cursor time rather than moving it to -8.8s');
    }
  });
  test('zoom in and out preserves cursor time near either history boundary', () => {
    for (const fraction of [0.05, 0.95]) {
      const { api, nodes } = harness(); nodes.graphWindow.value = '0';
      api.setHistory(Array.from({ length: 101 }, (_, i) => ({ t: 100000 + i * 100, vbus: 5 })));
      api.drawGraph();
      const plot = api.plot(), x = plot.padL + plot.iw * fraction, target = api.timeAt(x);
      for (const delta of [-100, -100, 100, 100]) {
        api.wheel(x, delta);
        assert(Math.abs(api.timeAt(x) - target) < 1e-6, 'History bounds do not shift the cursor anchor');
      }
    }
  });
  test('zooming back out resumes live scrolling without clearing history', () => {
    for (const mode of ['stream', 'poll']) {
      const { api } = harness(), points = Array.from({ length: 601 }, (_, i) => ({ t: 100000 + i * 100, vbus: 5 }));
      api.setCapture(mode); api.setHistory(points); api.drawGraph();
      const plot = api.plot(), x = plot.padL + plot.iw * 0.4;
      api.wheel(x, -100); api.wheel(x, -100);
      points.push({ t: 165000, vbus: 5 }); api.setHistory(points); api.drawGraph();
      const cursorTime = api.timeAt(x);
      api.wheel(x, 100);
      assert(Math.abs(api.timeAt(x) - cursorTime) < 1e-6, 'Partial zoom-out keeps the cursor anchor');
      api.wheel(x, 100);
      equal(api.plot().t1, 165000, 'Returning to the selected window follows the latest sample');
      points.push({ t: 170000, vbus: 5 }); api.setHistory(points); api.drawGraph();
      equal(api.plot().t1, 170000, 'Subsequent samples scroll the graph');
      equal(api.plot().spanMs, 30000, 'Selected window is restored');
      equal(points.length, 603, 'History is retained');
    }
  });
  test('zooming out to all resumes following and includes later history', () => {
    const { api, nodes } = harness(), points = Array.from({ length: 101 }, (_, i) => ({ t: 100000 + i * 100, vbus: 5 }));
    nodes.graphWindow.value = '0'; api.setCapture('stream'); api.setHistory(points); api.drawGraph();
    const plot = api.plot(), x = plot.padL + plot.iw * 0.5;
    api.wheel(x, -100);
    points.push({ t: 111000, vbus: 5 }); api.setHistory(points); api.drawGraph();
    api.wheel(x, 100); api.wheel(x, 100);
    equal(api.plot().t1, 111000, 'All returns to the live edge');
    assert(nodes.graphStat.textContent.includes(' · all'), 'All no longer has a fixed zoom span');
    points.push({ t: 115000, vbus: 5 }); api.setHistory(points); api.drawGraph();
    equal(api.plot().t1, 115000, 'All follows later samples');
    equal(api.plot().spanMs, 15000, 'All expands with new history');
  });
  test('two-finger horizontal scrolling pans both ways without changing zoom', () => {
    const { api } = harness();
    api.setHistory(Array.from({ length: 601 }, (_, i) => ({ t: 100000 + i * 100, vbus: 5 })));
    api.drawGraph();
    const plot = api.plot(), x = plot.padL + plot.iw / 2;
    api.wheel(x, -100);
    const zoomed = api.plot(), offset = 120 * zoomed.spanMs / zoomed.iw;
    api.wheel(x, 2, { deltaX: -120 });
    assert(Math.abs(api.plot().t1 - (zoomed.t1 - offset)) < 1e-6, 'Horizontal scroll moves to earlier time despite minor vertical noise');
    equal(api.plot().spanMs, zoomed.spanMs, 'Panning preserves zoom');
    api.wheel(x, -2, { deltaX: 120 });
    assert(Math.abs(api.plot().t1 - zoomed.t1) < 1e-6, 'Opposite scroll returns to the original time');
    equal(api.plot().spanMs, zoomed.spanMs, 'Opposite scroll preserves zoom');
  });
  test('horizontal scrolling stays within history and resumes following at the live edge', () => {
    const { api } = harness(), points = Array.from({ length: 601 }, (_, i) => ({ t: 100000 + i * 100, vbus: 5 }));
    api.setCapture('stream'); api.setHistory(points); api.drawGraph();
    const plot = api.plot(), x = plot.padL + plot.iw / 2;
    api.wheel(x, -100);
    const span = api.plot().spanMs;
    api.wheel(x, 0, { deltaX: -100000 });
    equal(api.plot().t1, 100000 + span, 'Oldest full window is the left boundary');
    points.push({ t: 161000, vbus: 5 }); api.setHistory(points); api.drawGraph();
    equal(api.plot().t1, 100000 + span, 'Inspecting history stays frozen during capture');
    api.wheel(x, 0, { deltaX: 100000 });
    equal(api.plot().t1, 161000, 'Right boundary is the latest sample');
    points.push({ t: 162000, vbus: 5 }); api.setHistory(points); api.drawGraph();
    equal(api.plot().t1, 162000, 'Returning to the live edge follows new samples');
    equal(api.plot().spanMs, span, 'Following retains the zoom level');
    equal(api.historySize(), 603, 'Panning retains every history point');
  });
  test('horizontal and empty scrolls do not accidentally zoom an unzoomed graph', () => {
    const { api } = harness();
    api.setCapture('stream'); api.setHistory([{ t: 100000, vbus: 5 }, { t: 160000, vbus: 5 }]); api.drawGraph();
    const plot = api.plot(), x = plot.padL + plot.iw / 2;
    api.wheel(x, 0, { deltaX: -100 }); api.wheel(x, 0);
    equal(api.plot().spanMs, 30000, 'No accidental zoom from horizontal or empty events');
    api.setHistory([{ t: 100000, vbus: 5 }, { t: 161000, vbus: 5 }]); api.drawGraph();
    equal(api.plot().t1, 161000, 'Unzoomed graph still follows capture');
  });
  test('horizontal scroll units are converted without an initial jump from zoom margins', () => {
    const { api } = harness();
    api.setHistory([{ t: 100000, vbus: 5 }, { t: 114000, vbus: 5 }]); api.drawGraph();
    const plot = api.plot(), x = plot.padL + plot.iw * 0.05;
    api.wheel(x, -100);
    const zoomed = api.plot();
    api.wheel(x, 0, { deltaX: 1, deltaMode: 1 });
    assert(Math.abs(api.plot().t1 - (zoomed.t1 + 16 * zoomed.spanMs / zoomed.iw)) < 1e-6, 'Line scroll moves smoothly from an existing empty margin');
    api.wheel(x, 0, { deltaX: 1, deltaMode: 2 });
    equal(api.plot().t1, 114000, 'Page scroll is bounded at the live edge');
    equal(api.plot().spanMs, zoomed.spanMs, 'Scroll units never alter zoom');
  });
  return passed;
}
try {
  const passed = runTests();
  globalThis.GRAPH_TEST_RESULT = { passed };
  if (typeof console !== 'undefined') console.log(`${passed.length} checks passed\n${passed.join('\n')}`);
} catch (error) {
  globalThis.GRAPH_TEST_RESULT = { error: String(error) + (error.stack ? '\n' + error.stack : '') };
  if (typeof console !== 'undefined') console.error(error);
  if (typeof process !== 'undefined') process.exitCode = 1;
}
