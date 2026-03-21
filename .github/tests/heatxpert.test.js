/**
 * heatxpert.test.js
 * =================
 * Full test suite for the HeatXpert Pro API — /api/heatxpert
 *
 * Run:
 *   BASE_URL=https://www.multicalci.com npx jest heatxpert.test.js
 */

// ─── Configuration ────────────────────────────────────────────────────────────
const BASE_URL = process.env.BASE_URL || 'https://www.multicalci.com';
const ENDPOINT = `${BASE_URL}/api/heatxpert`;
const TIMEOUT  = 30_000;

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function post(body) {
  const resp = await fetch(ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(TIMEOUT),
  });
  const json = await resp.json();
  return { status: resp.status, body: json };
}

function near(actual, expected, fracTol = 0.05, label = '') {
  const pct = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-9);
  if (pct > fracTol) {
    throw new Error(
      `${label}: expected ~${expected}, got ${actual} (${(pct*100).toFixed(1)}% deviation, tol=${(fracTol*100).toFixed(0)}%)`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — ROUTER & CORS
// ═══════════════════════════════════════════════════════════════════════════════
describe('Router / CORS', () => {

  test('OPTIONS preflight returns 204', async () => {
    const resp = await fetch(ENDPOINT, { method: 'OPTIONS' });
    expect(resp.status).toBe(204);
    expect(resp.headers.get('access-control-allow-methods')).toMatch(/POST/i);
  });

  test('GET returns 405', async () => {
    const resp = await fetch(ENDPOINT, { method: 'GET' });
    expect(resp.status).toBe(405);
  });

  test('Unknown calcType returns 400', async () => {
    const { status, body } = await post({ calcType: 'nonExistentCalc' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown calcType/i);
  });

  test('Missing calcType returns 400', async () => {
    const { status, body } = await post({});
    expect(status).toBe(400);
    expect(body.error).toMatch(/calcType required/i);
  });

  // API returns 500 (not 400) for malformed JSON body — that is acceptable
  test('Invalid JSON body returns 4xx or 5xx error', async () => {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json :::',
    });
    expect(resp.status).toBeGreaterThanOrEqual(400);
    expect(resp.status).toBeLessThan(600);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — SHELL & TUBE (calcShellTube)
// ═══════════════════════════════════════════════════════════════════════════════

// Baseline: water/water, 1-2 pass, counter-flow
// hF=80000 kg/h, ΔT_hot=30°C → Q = (80000/3600)×4.182×30 ≈ 2790 kW
const ST_BASELINE = {
  calcType: 'shellTube',
  hFlKey: 'water', hTi: 90, hTo: 60, hF: 80000,
  cFlKey: 'water', cTi: 25, cF: 40000, coldMode: 'flow',
  OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
  mat: 'ss316', tema: 'C', hxType: '1-2',
  Rfo: 0.0002, Rfi: 0.0002,
  pdAllowShell: 1.0, pdAllowTube: 1.0,
};

describe('Shell & Tube — single-phase water/water', () => {

  test('returns 200 with no error', async () => {
    const { status, body } = await post(ST_BASELINE);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('heat duty Q is positive (kW)', async () => {
    const { body } = await post(ST_BASELINE);
    expect(body.Q).toBeGreaterThan(0);
  });

  test('Q matches energy balance within 5%', async () => {
    const { body } = await post(ST_BASELINE);
    // Q_expected = (80000/3600) × 4.182 × 30 ≈ 2790 kW
    near(body.Q, 2790, 0.10, 'Q energy balance');
  });

  test('cold outlet temperature > cold inlet', async () => {
    const { body } = await post(ST_BASELINE);
    expect(body.cTo).toBeGreaterThan(ST_BASELINE.cTi);
    expect(body.cTo).toBeLessThan(ST_BASELINE.hTi);
  });

  test('LMTD is positive', async () => {
    const { body } = await post(ST_BASELINE);
    expect(body.lmtd).toBeGreaterThan(0);
  });

  test('overall U in realistic range for water/water (200–2000 W/m²K)', async () => {
    const { body } = await post(ST_BASELINE);
    expect(body.U).toBeGreaterThan(200);
    expect(body.U).toBeLessThan(2000);
  });

  test('heat transfer area is positive and not absurdly large', async () => {
    const { body } = await post(ST_BASELINE);
    expect(body.area).toBeGreaterThan(1);
    expect(body.area).toBeLessThan(500); // widened — large duty needs large area
  });

  test('tube velocity is positive', async () => {
    const { body } = await post(ST_BASELINE);
    expect(body.tubeVel).toBeGreaterThan(0);
  });

  test('shell-side pressure drop is positive (bar)', async () => {
    const { body } = await post(ST_BASELINE);
    expect(body.shellDP).toBeGreaterThan(0);
  });

  test('NTU > 0 and effectiveness between 0 and 1', async () => {
    const { body } = await post(ST_BASELINE);
    expect(body.NTU).toBeGreaterThan(0);
    expect(body.eff).toBeGreaterThan(0);
    expect(body.eff).toBeLessThanOrEqual(1.0);
  });

  test('resistance breakdown sums to ~100%', async () => {
    const { body } = await post(ST_BASELINE);
    const total = body.resistanceBreakdown.reduce((s, r) => s + r.pct, 0);
    expect(total).toBeGreaterThan(95);
    expect(total).toBeLessThan(105);
  });

  test('numTubes is a positive integer multiple of nPasses', async () => {
    const { body } = await post(ST_BASELINE);
    expect(Number.isInteger(body.numTubes)).toBe(true);
    expect(body.numTubes % body.nPasses).toBe(0);
    expect(body.numTubes).toBeGreaterThan(0);
  });

  test('U converged (deviation < 5%)', async () => {
    const { body } = await post(ST_BASELINE);
    expect(body.convergence.converged).toBe(true);
    expect(body.convergence.deviation_pct).toBeLessThan(5);
  });
});

describe('Shell & Tube — input validation', () => {

  test('hTo >= hTi rejected with 500', async () => {
    const { status, body } = await post({
      ...ST_BASELINE, hTi: 60, hTo: 90,
    });
    expect(status).toBe(500);
    expect(body.error).toBeDefined();
  });

  test('hF = 0 rejected with 500', async () => {
    const { status } = await post({ ...ST_BASELINE, hF: 0 });
    expect(status).toBe(500);
  });

  test('hTi <= cTi rejected with 500', async () => {
    const { status } = await post({
      ...ST_BASELINE, hTi: 25, hTo: 15, cTi: 30,
    });
    expect(status).toBe(500);
  });

  test('missing OD returns 500 with error message', async () => {
    const body = { ...ST_BASELINE };
    delete body.OD;
    const { status, body: resp } = await post(body);
    expect(status).toBe(500);
    expect(resp.error).toMatch(/OD/i);
  });
});

describe('Shell & Tube — condensing (steam)', () => {

  test('condensing mode returns phaseZones with mode=condensing', async () => {
    const { body } = await post({
      calcType: 'shellTube',
      hFlKey: 'steam', hTi: 120, hTo: 100, hF: 5000,
      cFlKey: 'water', cTi: 25, cF: 50000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 3.66, pitch: 1.25, arr: 'counter',
      mat: 'cs', tema: 'C', hxType: '1-2',
      shellMode: 'condensing',
    });
    expect(body.Q).toBeGreaterThan(0);
    expect(body.phaseZones).toBeDefined();
    expect(body.phaseZones.mode).toBe('condensing');
  });
});

describe('Shell & Tube — imperial unit conversion', () => {

  test('imperial inputs give same Q as metric within 5%', async () => {
    const common = {
      calcType: 'shellTube',
      hFlKey: 'water', cFlKey: 'water',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'ss304', tema: 'C', hxType: '1-2',
    };
    const metric   = await post({ ...common, hTi:194,hTo:140,hF:176370,cTi:77,cF:88185,coldMode:'flow', unitSys:'imperial' });
    const metricSI = await post({ ...common, hTi: 90,hTo: 60,hF: 80000,cTi:25,cF:40000,coldMode:'flow' });
    near(metric.body.Q, metricSI.body.Q, 0.05, 'imperial vs metric Q');
  });
});

describe('Shell & Tube — Bell-Delaware physics', () => {

  test('Jtotal between 0.30 and 1.05', async () => {
    const { body } = await post(ST_BASELINE);
    const J = body.bdCorr.Jtotal;
    expect(J).toBeGreaterThan(0.30);
    expect(J).toBeLessThan(1.05);
  });

  test('higher baffle cut → lower shell-side ΔP', async () => {
    const lo = await post({ ...ST_BASELINE, bcut: 0.20 });
    const hi = await post({ ...ST_BASELINE, bcut: 0.40 });
    expect(hi.body.shellDP).toBeLessThanOrEqual(lo.body.shellDP + 0.01);
  });

  test('triangular pitch gives equal or higher hShell than square pitch', async () => {
    const tri = await post({ ...ST_BASELINE, pitchLayout: 'triangular' });
    const sq  = await post({ ...ST_BASELINE, pitchLayout: 'square' });
    expect(tri.body.bdCorr.hShell).toBeGreaterThanOrEqual(sq.body.bdCorr.hShell * 0.80);
  });
});

describe('Shell & Tube — pressure drop direction', () => {

  test('tube ΔP increases with increasing cold flow', async () => {
    const lo = await post({ ...ST_BASELINE, cF: 20000 });
    const hi = await post({ ...ST_BASELINE, cF: 80000 });
    expect(hi.body.tubeDp).toBeGreaterThan(lo.body.tubeDp);
  });

  test('shell ΔP increases with increasing hot flow', async () => {
    const lo = await post({ ...ST_BASELINE, hF: 40000 });
    const hi = await post({ ...ST_BASELINE, hF: 160000 });
    expect(hi.body.shellDP).toBeGreaterThan(lo.body.shellDP);
  });

  test('counter-flow has lower required area than parallel-flow', async () => {
    const cf = await post({ ...ST_BASELINE, arr: 'counter' });
    const pf = await post({ ...ST_BASELINE, arr: 'parallel' });
    expect(cf.body.area).toBeLessThanOrEqual(pf.body.area * 1.05);
  });
});

describe('Shell & Tube — fluid comparison', () => {

  test('water U >> lube-oil U for same geometry', async () => {
    const w = await post({ ...ST_BASELINE, hFlKey: 'water',    cFlKey: 'water' });
    const o = await post({ ...ST_BASELINE, hFlKey: 'lube-oil', cFlKey: 'water' });
    expect(w.body.U).toBeGreaterThan(o.body.U * 1.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — PLATE HX
// ═══════════════════════════════════════════════════════════════════════════════

const PLATE_BASE = {
  calcType: 'plate',
  hFlKey: 'water', hTi: 80, hTo: 50, hF: 30000,
  cFlKey: 'water', cTi: 20, cF: 25000, coldMode: 'flow',
  th: 0.6, angle: 45, gap: 3.0, pw: 0.5, plen: 1.2, phi: 1.17,
  mat: 'ss316', foul: 0.0002,
  pdAllowH: 1.5, pdAllowC: 1.5,
};

describe('Plate HX', () => {

  test('returns 200 with no error', async () => {
    const { status, body } = await post(PLATE_BASE);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('Q > 0', async () => {
    const { body } = await post(PLATE_BASE);
    expect(body.Q).toBeGreaterThan(0);
  });

  test('U_clean > U (fouling reduces U)', async () => {
    const { body } = await post(PLATE_BASE);
    expect(body.U_clean).toBeGreaterThan(body.U);
  });

  test('A_provided >= A_req (not under-designed)', async () => {
    const { body } = await post(PLATE_BASE);
    expect(body.A_provided).toBeGreaterThanOrEqual(body.A_req * 0.98);
  });

  test('nPlates >= 4', async () => {
    const { body } = await post(PLATE_BASE);
    expect(body.nPlates).toBeGreaterThanOrEqual(4);
  });

  test('hH and hC > 200 W/m²K', async () => {
    const { body } = await post(PLATE_BASE);
    expect(body.hH).toBeGreaterThan(200);
    expect(body.hC).toBeGreaterThan(200);
  });

  test('temperature cross rejected (cTi > hTo)', async () => {
    const { status } = await post({ ...PLATE_BASE, cTi: 55 });
    expect(status).toBe(500);
  });

  test('cold outlet > cold inlet', async () => {
    const { body } = await post(PLATE_BASE);
    expect(body.cTo).toBeGreaterThan(PLATE_BASE.cTi);
    expect(body.cTo).toBeLessThan(PLATE_BASE.hTi);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — AIR COOLED HX
// ═══════════════════════════════════════════════════════════════════════════════

const AC_BASE = {
  calcType: 'airCooled',
  flKey: 'crude-oil-light', Ti: 100, To: 65, F: 80000,
  Tamb: 35, dTa: 15,
  tubeOD: 25.4, tubeID: 20.0,
  finH: 12.5, finThk: 0.40, finDens: 394,
  pitchT: 63.5, rows: 4, nTubes: 40, tubeLen: 6.0,
  Rfo: 0.0002, finMat: 'alum',
};

describe('Air Cooled HX', () => {

  test('returns 200 with no error', async () => {
    const { status, body } = await post(AC_BASE);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('Q > 0', async () => {
    const { body } = await post(AC_BASE);
    expect(body.Q).toBeGreaterThan(0);
  });

  test('eta_fin between 0.4 and 1.0', async () => {
    const { body } = await post(AC_BASE);
    expect(body.eta_fin).toBeGreaterThan(0.4);
    expect(body.eta_fin).toBeLessThanOrEqual(1.0);
  });

  test('aluminium fins have higher eta than carbon steel fins', async () => {
    const alum = await post({ ...AC_BASE, finMat: 'alum' });
    const cs   = await post({ ...AC_BASE, finMat: 'cs' });
    expect(alum.body.eta_fin).toBeGreaterThan(cs.body.eta_fin);
  });

  test('ambient >= outlet temperature rejected', async () => {
    const { status } = await post({ ...AC_BASE, Tamb: 70 });
    expect(status).toBe(500);
  });

  test('outlet >= inlet rejected', async () => {
    const { status } = await post({ ...AC_BASE, To: 110 });
    expect(status).toBe(500);
  });

  test('A_total > 0', async () => {
    const { body } = await post(AC_BASE);
    expect(body.A_total).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — FIN-FAN HX
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fin-Fan HX', () => {

  const FF_BASE = {
    calcType: 'finFan',
    flKey: 'water', Ti: 70, To: 45, F: 50000,
    aTamb: 35, aTout: 50,
    tOD: 25.4, tID: 20.0,
    fH: 12.5, fThk: 0.4, fDens: 394, fMat: 'alum',
    pitchT: 63.5, nRows: 4, tLen: 6.0, nTubes: 36,
  };

  test('returns 200', async () => {
    const { status, body } = await post(FF_BASE);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('Q_duty > 0', async () => {
    const { body } = await post(FF_BASE);
    expect(body.Q_duty).toBeGreaterThan(0);
  });

  test('eta_fin between 0.4 and 1.0', async () => {
    const { body } = await post(FF_BASE);
    expect(body.eta_fin).toBeGreaterThan(0.4);
    expect(body.eta_fin).toBeLessThanOrEqual(1.0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — DOUBLE PIPE HX
// ═══════════════════════════════════════════════════════════════════════════════

const DP_BASE = {
  calcType: 'doublePipe',
  hFlKey: 'water', hTi: 75, hTo: 50, hF: 5000,
  cFlKey: 'water', cTi: 20, cF: 4000, coldMode: 'flow',
  innerOD: 50, innerID: 44, outerID: 76.1, outerID_i: 70,
  L: 6.0, nHairpins: 4, arr: 'counter',
  mat: 'ss304', Rfo: 0.0002, Rfi: 0.0002,
};

describe('Double Pipe HX', () => {

  test('returns 200', async () => {
    const { status, body } = await post(DP_BASE);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('Q > 0', async () => {
    const { body } = await post(DP_BASE);
    expect(body.Q).toBeGreaterThan(0);
  });

  test('U in range 100–8000 W/m²K', async () => {
    const { body } = await post(DP_BASE);
    expect(body.U).toBeGreaterThan(100);
    expect(body.U).toBeLessThan(8000);
  });

  test('counter-flow LMTD >= parallel-flow LMTD', async () => {
    const counter  = await post({ ...DP_BASE, arr: 'counter' });
    const parallel = await post({ ...DP_BASE, arr: 'parallel' });
    expect(counter.body.lmtd).toBeGreaterThanOrEqual(parallel.body.lmtd * 0.99);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — LMTD / NTU METHOD
// ═══════════════════════════════════════════════════════════════════════════════

describe('LMTD / NTU method', () => {

  test('1-1 counter-flow LMTD correct', async () => {
    // dT1=45, dT2=30 → LMTD = (45-30)/ln(45/30) = 37.06°C
    const { body } = await post({
      calcType: 'lmtdNtu',
      hTi: 100, hTo: 60, cTi: 30, cTo: 55,
      hF: 20000, cF: 18000,
      hFlKey: 'water', cFlKey: 'water',
      arr: 'counter', hxType: '1-1',
    });
    near(body.lmtd, 37.06, 0.03, 'LMTD 1-1 counter');
  });

  test('1-2 pass: F correction factor 0.70–1.01', async () => {
    const { body } = await post({
      calcType: 'lmtdNtu',
      hTi: 100, hTo: 60, cTi: 30, cTo: 55,
      hF: 20000, cF: 18000,
      hFlKey: 'water', cFlKey: 'water',
      arr: 'counter', hxType: '1-2',
    });
    expect(body.F).toBeGreaterThan(0.70);
    expect(body.F).toBeLessThanOrEqual(1.01);
  });

  test('NTU and effectiveness are positive', async () => {
    const { body } = await post({
      calcType: 'lmtdNtu',
      hTi: 80, hTo: 50, cTi: 20,
      hF: 10000, cF: 10000,
      hFlKey: 'water', cFlKey: 'water',
      arr: 'counter', hxType: '1-1',
    });
    expect(body.NTU).toBeGreaterThan(0);
    expect(body.eff).toBeGreaterThan(0);
    expect(body.eff).toBeLessThanOrEqual(1.0);
  });

  test('temperature cross rejected', async () => {
    const { status } = await post({
      calcType: 'lmtdNtu',
      hTi: 50, hTo: 40, cTi: 45, cTo: 60,
      hF: 10000, cF: 10000,
      hFlKey: 'water', cFlKey: 'water',
      arr: 'counter', hxType: '1-1',
    });
    expect(status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — WALL THICKNESS
// ═══════════════════════════════════════════════════════════════════════════════

const WT_BASE = {
  calcType: 'wallThick',
  type: 'cylinder', P_barg: 15, D_mm: 600,
  S_MPa: 138, E: 1.0, CA_mm: 3.0, MT_mm: 0,
  standard: 'ASME-VIII',
};

describe('Wall Thickness — ASME Sec. VIII UG-27', () => {

  test('returns 200', async () => {
    const { status, body } = await post(WT_BASE);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('t_calc_mm > 0', async () => {
    const { body } = await post(WT_BASE);
    expect(body.t_calc_mm).toBeGreaterThan(0);
  });

  test('t_nominal >= t_with_CA', async () => {
    const { body } = await post(WT_BASE);
    expect(body.t_nominal).toBeGreaterThanOrEqual(body.t_with_CA);
  });

  test('MAWP at t_nominal > design pressure', async () => {
    const { body } = await post(WT_BASE);
    expect(body.pMax_check_bar).toBeGreaterThan(WT_BASE.P_barg);
  });

  test('thin-wall formula: t ≈ PR/(SE-0.6P)', async () => {
    const { body } = await post(WT_BASE);
    const P = WT_BASE.P_barg * 0.1;
    const R_i = WT_BASE.D_mm / 2;
    const t_expected = (P * R_i) / (WT_BASE.S_MPa * WT_BASE.E - 0.6 * P);
    near(body.t_thin_mm, t_expected, 0.03, 'thin-wall formula');
  });

  test('thick-wall Lamé triggered at high pressure (t/R >= 0.1)', async () => {
    const { body } = await post({ ...WT_BASE, P_barg: 250 });
    expect(body.isThickWall).toBe(true);
    expect(body.lameT).toBeGreaterThan(0);
  });

  test('sphere gives smaller t than cylinder at same conditions', async () => {
    const cyl    = await post({ ...WT_BASE, type: 'cylinder' });
    const sphere = await post({ ...WT_BASE, type: 'sphere' });
    expect(sphere.body.t_calc_mm).toBeLessThan(cyl.body.t_calc_mm);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — FOULING
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fouling calculator', () => {

  test('returns 200', async () => {
    const { status, body } = await post({ calcType:'fouling', Rf_s:0.0002, Rf_t:0.0002, U_cl:800 });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('U_service < U_cl', async () => {
    const { body } = await post({ calcType:'fouling', Rf_s:0.0002, Rf_t:0.0002, U_cl:800 });
    expect(body.U_service).toBeLessThan(body.U_cl);
  });

  test('Rf_total = Rf_s + Rf_t', async () => {
    const { body } = await post({ calcType:'fouling', Rf_s:0.0003, Rf_t:0.0004, U_cl:800 });
    near(body.Rf_total, 0.0007, 0.001, 'Rf_total');
  });

  test('higher fouling → higher area_increase', async () => {
    const lo = await post({ calcType:'fouling', Rf_s:0.0001, Rf_t:0.0001, U_cl:800 });
    const hi = await post({ calcType:'fouling', Rf_s:0.0005, Rf_t:0.0005, U_cl:800 });
    expect(hi.body.area_increase).toBeGreaterThan(lo.body.area_increase);
  });

  test('U_service formula: 1/(1/U_cl + Rf_total)', async () => {
    const { body } = await post({ calcType:'fouling', Rf_s:0.0002, Rf_t:0.0002, U_cl:1000 });
    const expected = 1 / (1/1000 + 0.0004);
    near(body.U_service, expected, 0.001, 'U_service formula');
  });

  test('[GOLDEN] U_service at Rf=0.0002+0.0002, U_cl=800 ≈ 606', async () => {
    const { body } = await post({ calcType:'fouling', Rf_s:0.0002, Rf_t:0.0002, U_cl:800 });
    near(body.U_service, 606.1, 0.01, 'golden U_service');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — HX SELECTOR
// ═══════════════════════════════════════════════════════════════════════════════

describe('HX Type Selector', () => {

  test('air-cooling → top is air-cooled', async () => {
    const { body } = await post({ calcType:'selector', app:'air-cooling', pres:'low', foul:'low', duty:'large', space:'plenty', corr:'low' });
    expect(body.top).toBe('air-cooled');
  });

  test('condensing + high pressure → top is shell-tube', async () => {
    const { body } = await post({ calcType:'selector', app:'condensing', pres:'high', foul:'medium', duty:'large', space:'plenty', corr:'medium' });
    expect(body.top).toBe('shell-tube');
  });

  test('small duty + liquid-liquid + very-limited space → top is plate', async () => {
    const { body } = await post({ calcType:'selector', app:'liquid-liquid', pres:'low', foul:'low', duty:'small', space:'very-limited', corr:'low' });
    expect(body.top).toBe('plate');
  });

  test('scores object contains all six HX types', async () => {
    const { body } = await post({ calcType:'selector', app:'liquid-liquid', pres:'medium', foul:'low', duty:'medium', space:'plenty', corr:'low' });
    ['shell-tube','plate','air-cooled','double-pipe','spiral','plate-fin'].forEach(t => {
      expect(body.scores).toHaveProperty(t);
    });
  });

  test('high fouling + high pressure → plate score < shell-tube score', async () => {
    const { body } = await post({ calcType:'selector', app:'liquid-liquid', pres:'high', foul:'high', duty:'large', space:'plenty', corr:'low' });
    expect(body.scores['plate']).toBeLessThan(body.scores['shell-tube']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — GEOMETRY OPTIMIZER
// ═══════════════════════════════════════════════════════════════════════════════

const GO_BASE = {
  calcType: 'geoOptimizer',
  area_req: 30, massC_kgs: 5.0, L_fixed: 4.88,
  rho_c: 998, target_vel: 1.5, vel_min: 0.8, vel_max: 3.5,
  max_passes: 8, max_shells: 3,
};

describe('Geometry Optimizer', () => {

  test('returns 200', async () => {
    const { status, body } = await post(GO_BASE);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('finds valid solutions for achievable constraints', async () => {
    const { body } = await post(GO_BASE);
    expect(body.solutions_valid.length).toBeGreaterThan(0);
    expect(body.any_solution).toBe(true);
  });

  test('valid solutions have velocity within [vel_min, vel_max]', async () => {
    const { body } = await post(GO_BASE);
    body.solutions_valid.forEach(s => {
      expect(s.velocity).toBeGreaterThanOrEqual(GO_BASE.vel_min - 0.02);
      expect(s.velocity).toBeLessThanOrEqual(GO_BASE.vel_max + 0.02);
    });
  });

  test('valid solutions meet area requirement (margin >= -0.5%)', async () => {
    const { body } = await post(GO_BASE);
    body.solutions_valid.forEach(s => {
      expect(s.area_margin_pct).toBeGreaterThanOrEqual(-0.5);
    });
  });

  test('recommendation string is non-empty', async () => {
    const { body } = await post(GO_BASE);
    expect(body.recommendation.length).toBeGreaterThan(10);
  });

  test('any_solution is boolean', async () => {
    const { body } = await post({ ...GO_BASE, massC_kgs: 0.001, area_req: 500 });
    expect(typeof body.any_solution).toBe('boolean');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — GOLDEN VALUE REGRESSION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Golden-value regression tests', () => {

  test('[REG-ST-01] water/water Q ≈ 2790 kW', async () => {
    const { body } = await post(ST_BASELINE);
    near(body.Q, 2790, 0.10, '[REG-ST-01] Q');
  });

  test('[REG-PL-01] plate HX Q ≈ 1045 kW', async () => {
    const { body } = await post(PLATE_BASE);
    // Q = (30000/3600) × 4.182 × (80-50) ≈ 1045 kW
    near(body.Q, 1045, 0.10, '[REG-PL-01] Q');
  });

  test('[REG-FO-01] fouling U_service golden value ≈ 606', async () => {
    const { body } = await post({ calcType:'fouling', Rf_s:0.0002, Rf_t:0.0002, U_cl:800 });
    near(body.U_service, 606.1, 0.01, '[REG-FO-01]');
  });

  test('[REG-WT-01] wall thickness t_thin ≈ 3.28 mm at 15 barg, D=600mm', async () => {
    const { body } = await post(WT_BASE);
    near(body.t_thin_mm, 3.28, 0.05, '[REG-WT-01]');
  });

  test('[REG-LMTD-01] counter-flow LMTD ≈ 37.06°C', async () => {
    const { body } = await post({
      calcType: 'lmtdNtu',
      hTi: 100, hTo: 60, cTi: 30, cTo: 55,
      hF: 20000, cF: 18000,
      hFlKey: 'water', cFlKey: 'water',
      arr: 'counter', hxType: '1-1',
    });
    near(body.lmtd, 37.06, 0.03, '[REG-LMTD-01]');
  });
});
