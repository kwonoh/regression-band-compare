import * as Plot from '@observablehq/plot';
import * as duckdb from '@duckdb/duckdb-wasm';
import * as vg from '@uwdata/vgplot';

const SIZE = { width: 480, height: 360, marginLeft: 50, marginRight: 20, marginTop: 20, marginBottom: 40 };

const DATASETS = [
  {
    name: 'athletes',
    title: 'Athletes: height vs. weight, by sex',
    x: 'weight', y: 'height', z: 'sex',
    create: `CREATE TABLE athletes AS SELECT weight, height, sex FROM 'athletes.csv'
      WHERE weight IS NOT NULL AND height IS NOT NULL`
  },
  {
    name: 'close_fit',
    title: 'Synthetic close fit: y = 10 + 0.5x + N(0, 1.5²), n = 30',
    x: 'x', y: 'y',
    create: `CREATE TABLE close_fit AS SELECT * FROM (VALUES ${closeFitValues(30)}) t(x, y)`
  }
];

function closeFitValues(n) {
  let s = 42;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  return Array.from({ length: n }, () => {
    const x = 100 * rand();
    const noise = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    return `(${x}, ${10 + 0.5 * x + 1.5 * noise})`;
  }).join(', ');
}

async function connect() {
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(__ASSETS__.worker));
  await db.instantiate(__ASSETS__.wasm);
  const csv = await fetch(__ASSETS__.athletes).then(r => r.arrayBuffer());
  await db.registerFileBuffer('athletes.csv', new Uint8Array(csv));
  return db.connect();
}

function rootSvg(el) {
  return el.tagName === 'svg' ? el : el.querySelector('svg');
}

function pathData(svg, selector, attr) {
  const out = {};
  for (const p of svg.querySelectorAll(selector)) {
    out[p.getAttribute(attr) ?? 'single'] = p.getAttribute('d');
  }
  return out;
}

async function rendered(el) {
  const done = () => el.querySelector('g[aria-label="area"] path') && el.querySelector('g[aria-label="line"] path');
  for (let i = 0; i < 600 && !done(); ++i) await new Promise(r => setTimeout(r, 50));
  if (!done()) throw new Error('vgplot did not render');
  let prev;
  do {
    prev = el.innerHTML;
    await new Promise(r => setTimeout(r, 200));
  } while (prev !== el.innerHTML);
}

async function compare(d) {
  const { coordinator } = vg;
  await coordinator().exec(d.create);

  const cols = [d.x, d.y, ...(d.z ? [d.z] : [])].join(', ');
  const rows = (await coordinator().query(`SELECT ${cols} FROM ${d.name}`)).toArray().map(r => ({ ...r }));
  const [ext] = (await coordinator().query(
    `SELECT MIN(${d.x}) x0, MAX(${d.x}) x1, MIN(${d.y}) y0, MAX(${d.y}) y1 FROM ${d.name}`
  )).toArray();
  const fits = (await coordinator().query(
    `SELECT ${d.z ? `${d.z} AS g` : `'single' AS g`}, regr_r2(${d.y}, ${d.x}) r2, regr_count(${d.y}, ${d.x}) n
     FROM ${d.name} GROUP BY ALL ORDER BY g`
  )).toArray().map(r => ({ ...r, n: Number(r.n) }));

  const pad = 0.25 * (ext.y1 - ext.y0);
  const xDomain = [ext.x0, ext.x1];
  const yDomain = [ext.y0 - pad, ext.y1 + pad];
  const colorDomain = d.z ? fits.map(f => f.g) : null;

  const channels = { x: d.x, y: d.y, ...(d.z ? { stroke: d.z } : {}) };
  const dotStyle = { r: 1.5, strokeOpacity: 0.3 };

  const plotEl = Plot.plot({
    ...SIZE,
    x: { domain: xDomain },
    y: { domain: yDomain },
    ...(colorDomain ? { color: { domain: colorDomain } } : {}),
    marks: [
      Plot.dot(rows, { ...channels, ...dotStyle }),
      Plot.linearRegressionY(rows, channels)
    ]
  });

  const vgEl = vg.plot(
    vg.dot(vg.from(d.name), { ...channels, ...dotStyle }),
    vg.regressionY(vg.from(d.name), channels),
    vg.width(SIZE.width), vg.height(SIZE.height),
    vg.marginLeft(SIZE.marginLeft), vg.marginRight(SIZE.marginRight),
    vg.marginTop(SIZE.marginTop), vg.marginBottom(SIZE.marginBottom),
    vg.xDomain(xDomain), vg.yDomain(yDomain),
    ...(colorDomain ? [vg.colorDomain(colorDomain)] : [])
  );
  document.body.append(vgEl, plotEl);
  await rendered(vgEl);

  const plotSvg = rootSvg(plotEl);
  const vgSvg = rootSvg(vgEl);
  return {
    name: d.name,
    title: d.title,
    size: SIZE,
    fits,
    plot: {
      svg: plotSvg.outerHTML,
      band: pathData(plotSvg, 'g[aria-label="linear-regression"] path[stroke="none"]', 'fill'),
      line: pathData(plotSvg, 'g[aria-label="linear-regression"] path[fill="none"]', 'stroke')
    },
    vgplot: {
      svg: vgSvg.outerHTML,
      band: pathData(vgSvg, 'g[aria-label="area"] path', 'fill'),
      line: pathData(vgSvg, 'g[aria-label="line"] path', 'stroke')
    }
  };
}

window.results = (async () => {
  vg.coordinator().databaseConnector(new vg.DuckDBWASMConnector({ connection: await connect() }));
  const results = [];
  for (const d of DATASETS) results.push(await compare(d));
  return results;
})();
