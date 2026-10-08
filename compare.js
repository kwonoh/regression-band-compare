import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const here = import.meta.dirname;
if (!process.env.MOSAIC_DIR) {
  console.error('Set MOSAIC_DIR to a mosaic checkout with installed dependencies.');
  process.exit(1);
}
const MOSAIC_DIR = realpathSync(process.env.MOSAIC_DIR);
const SOURCE_REPO = process.env.SOURCE_REPO ?? MOSAIC_DIR;
const CHROMIUM = process.env.CHROMIUM;
const REGRESSION_MARK = 'packages/vgplot/plot/src/marks/RegressionMark.js';
const shortRev = rev => execFileSync('git', ['-C', SOURCE_REPO, 'rev-parse', '--short', rev], { encoding: 'utf8' }).trim();
const VARIANTS = [
  { name: 'before', label: 'vgplot before fix', rev: shortRev(process.env.BEFORE_REV ?? 'HEAD~1') },
  { name: 'after', label: 'vgplot after fix', rev: shortRev(process.env.AFTER_REV ?? 'HEAD') }
];
const TOLERANCE_PX = 0.01;

const require = createRequire(path.join(MOSAIC_DIR, 'package.json'));
const { createServer } = await import(require.resolve('vite'));
const { chromium } = require('playwright');
const { default: mosaicViteConfig } = await import(path.join(MOSAIC_DIR, 'vite.config.js'));

const plotDir = realpathSync(path.join(MOSAIC_DIR, 'packages/vgplot/plot/node_modules/@observablehq/plot'));
const duckdbDir = realpathSync(path.join(MOSAIC_DIR, 'packages/mosaic/core/node_modules/@duckdb/duckdb-wasm'));
const plotVersion = require(path.join(plotDir, 'package.json')).version;
const assets = {
  worker: `/@fs${duckdbDir}/dist/duckdb-browser-eh.worker.js`,
  wasm: `/@fs${duckdbDir}/dist/duckdb-eh.wasm`,
  athletes: `/@fs${MOSAIC_DIR}/docs/public/data/athletes.csv`
};

function swapRegressionMark(rev) {
  const source = execFileSync('git', ['-C', SOURCE_REPO, 'show', `${rev}:${REGRESSION_MARK}`], { encoding: 'utf8' });
  const plugin = {
    name: 'swap-regression-mark',
    enforce: 'pre',
    loads: 0,
    load(id) {
      if (id.split('?')[0].endsWith(`/${REGRESSION_MARK}`)) {
        ++plugin.loads;
        return source;
      }
    }
  };
  return plugin;
}

async function capture(browser, variant) {
  const plugin = swapRegressionMark(variant.rev);
  const server = await createServer({
    configFile: false,
    root: here,
    logLevel: 'error',
    cacheDir: path.join(here, 'node_modules/.vite', variant.name),
    resolve: {
      alias: {
        ...mosaicViteConfig.resolve.alias,
        '@observablehq/plot': plotDir,
        '@duckdb/duckdb-wasm': duckdbDir
      }
    },
    define: { __ASSETS__: JSON.stringify(assets) },
    server: { fs: { allow: [here, MOSAIC_DIR] } },
    plugins: [plugin]
  });
  await server.listen();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  try {
    await page.goto(server.resolvedUrls.local[0]);
    const results = await page.evaluate(() => window.results);
    if (plugin.loads === 0) throw new Error(`RegressionMark.js was not swapped for ${variant.name}`);
    return results;
  } catch (e) {
    console.error(errors);
    throw e;
  } finally {
    await page.close();
    await server.close();
  }
}

function points(d) {
  const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi).map(Number);
  const pts = [];
  for (let i = 0; i < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

function bandEdges(d) {
  const edges = new Map();
  for (const [x, y] of points(d)) {
    const key = x.toFixed(6);
    const e = edges.get(key) ?? { x, top: Infinity, bottom: -Infinity };
    e.top = Math.min(e.top, y);
    e.bottom = Math.max(e.bottom, y);
    edges.set(key, e);
  }
  return [...edges.values()].sort((a, b) => a.x - b.x);
}

function interpolate(edges, x, side) {
  let i = edges.findIndex(e => e.x >= x);
  if (i < 0) i = edges.length - 1;
  if (i === 0 || edges[i].x === x) return edges[i][side];
  const a = edges[i - 1], b = edges[i];
  return a[side] + (b[side] - a[side]) * (x - a.x) / (b.x - a.x);
}

function pairs(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length === 1 && kb.length === 1) return [[ka[0], a[ka[0]], b[kb[0]]]];
  if (ka.sort().join() !== kb.sort().join()) throw new Error(`group mismatch: ${ka} vs ${kb}`);
  return ka.map(k => [k, a[k], b[k]]);
}

function measure(result) {
  const groups = pairs(result.vgplot.band, result.plot.band).map(([key, vgBand, plotBand]) => {
    const vgEdges = bandEdges(vgBand);
    const plotEdges = bandEdges(plotBand);
    let maxEdgeDiff = 0, minRatio = Infinity, maxRatio = 0;
    for (const e of plotEdges) {
      const top = interpolate(vgEdges, e.x, 'top');
      const bottom = interpolate(vgEdges, e.x, 'bottom');
      maxEdgeDiff = Math.max(maxEdgeDiff, Math.abs(top - e.top), Math.abs(bottom - e.bottom));
      const ratio = (bottom - top) / (e.bottom - e.top);
      if (Number.isFinite(ratio)) {
        minRatio = Math.min(minRatio, ratio);
        maxRatio = Math.max(maxRatio, ratio);
      }
    }
    return { key, maxEdgeDiff, minRatio, maxRatio, vgSamples: vgEdges.length, plotSamples: plotEdges.length };
  });
  const lines = pairs(result.vgplot.line, result.plot.line).map(([key, vgLine, plotLine]) => {
    const v = points(vgLine), p = points(plotLine);
    const ends = [[v[0], p[0]], [v.at(-1), p.at(-1)]];
    return { key, maxEndpointDiff: Math.max(...ends.flatMap(([a, b]) => [Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])])) };
  });
  return { groups, lines };
}

function overlay(result) {
  const { width, height } = result.size;
  const paths = (band, line, style) =>
    Object.values(band).map(d => `<path d="${d}" ${style.band}/>`).join('') +
    Object.values(line).map(d => `<path d="${d}" ${style.line}/>`).join('');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background:white">` +
    paths(result.plot.band, result.plot.line, {
      band: 'fill="#4269d0" fill-opacity="0.25" stroke="none"',
      line: 'fill="none" stroke="#4269d0" stroke-width="1.5"'
    }) +
    paths(result.vgplot.band, result.vgplot.line, {
      band: 'fill="none" stroke="#ff2b2b" stroke-width="1" stroke-dasharray="4 2"',
      line: 'fill="none" stroke="#ff2b2b" stroke-width="1" stroke-dasharray="4 2"'
    }) +
    '</svg>';
}

function fmt(v, digits = 3) {
  return Number.isFinite(v) ? v.toFixed(digits) : String(v);
}

function report(runs) {
  const sections = runs.map(({ variant, results, metrics }) => `
    <h2>${variant.label} (<code>${variant.rev}</code>) vs Observable Plot ${plotVersion}</h2>
    ${results.map((r, i) => `
      <h3>${r.title}</h3>
      <div class="row">
        <figure>${r.vgplot.svg}<figcaption>vgplot <code>regressionY</code> (${variant.name} fix)</figcaption></figure>
        <figure>${r.plot.svg}<figcaption>Plot <code>linearRegressionY</code></figcaption></figure>
        <figure>${overlay(r)}<figcaption>Overlay: Plot filled blue, vgplot dashed red</figcaption></figure>
      </div>
      <table>
        <tr><th>group</th><th>n</th><th>R²</th><th>expected old/new width<br>1/√(1−R²)</th>
          <th>vgplot/Plot band width</th><th>max band edge Δ (px)</th><th>max line endpoint Δ (px)</th></tr>
        ${metrics[i].groups.map((g, j) => {
          const fit = r.fits.find(f => f.g === g.key) ?? r.fits[j];
          return `<tr><td>${fit.g}</td><td>${fit.n}</td><td>${fmt(fit.r2)}</td><td>${fmt(1 / Math.sqrt(1 - fit.r2))}</td>
            <td>${fmt(g.minRatio, 4)}–${fmt(g.maxRatio, 4)}</td><td>${fmt(g.maxEdgeDiff, 4)}</td>
            <td>${fmt(metrics[i].lines[j].maxEndpointDiff, 4)}</td></tr>`;
        }).join('')}
      </table>`).join('')}`).join('');
  return `<!doctype html><meta charset="utf-8"><title>regressionY vs linearRegressionY</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; color: #222; background: white; }
  .row { display: flex; gap: 16px; }
  figure { margin: 0; }
  figcaption { text-align: center; color: #555; }
  table { border-collapse: collapse; margin: 8px 0 24px; }
  th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: right; }
  h2 { border-top: 2px solid #222; padding-top: 12px; }
</style>
<h1>vgplot <code>regressionY</code> vs Observable Plot <code>linearRegressionY</code></h1>
<p>Same DuckDB table, size, margins, and x/y/color domains in both. vgplot runs from mosaic source
with only <code>${REGRESSION_MARK}</code> swapped per revision.</p>
${sections}`;
}

const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
const runs = [];
try {
  for (const variant of VARIANTS) {
    const results = await capture(browser, variant);
    runs.push({ variant, results, metrics: results.map(measure) });
  }
  mkdirSync(path.join(here, 'out'), { recursive: true });
  const html = path.join(here, 'out/report.html');
  writeFileSync(html, report(runs));
  writeFileSync(path.join(here, 'out/results.json'), JSON.stringify(runs.map(({ variant, metrics }) => ({ variant, metrics })), null, 2));
  const page = await browser.newPage({ viewport: { width: 1520, height: 900 } });
  await page.goto(`file://${html}`);
  await page.screenshot({ path: path.join(here, 'out/report.png'), fullPage: true });
  await page.close();
} finally {
  await browser.close();
}

let failed = false;
for (const { variant, results, metrics } of runs) {
  for (const [i, m] of metrics.entries()) {
    for (const [j, g] of m.groups.entries()) {
      const line = m.lines[j].maxEndpointDiff;
      console.log(
        `${variant.name.padEnd(6)} ${results[i].name.padEnd(9)} ${g.key.padEnd(8)}`,
        `band width ratio ${fmt(g.minRatio, 4)}-${fmt(g.maxRatio, 4)}`,
        `max edge diff ${fmt(g.maxEdgeDiff, 4)}px`,
        `line diff ${fmt(line, 4)}px`,
        `samples ${g.vgSamples}/${g.plotSamples}`
      );
      if (line > TOLERANCE_PX) failed = true;
      if (variant.name === 'after' && g.maxEdgeDiff > TOLERANCE_PX) failed = true;
    }
  }
}
console.log(`report: ${path.join(here, 'out/report.html')}`);
process.exitCode = failed ? 1 : 0;
