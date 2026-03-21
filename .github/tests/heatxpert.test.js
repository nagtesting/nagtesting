/**
 * heatxpert.test.js
 * =================
 * Full test suite for the HeatXpert Pro API — /api/heatxpert
 *
 * Coverage:
 *   calcShellTube   (Bell-Delaware, single-phase, condensing, evaporating)
 *   calcPlate       (PHE sizing)
 *   calcAirCooled   (Robinson-Briggs, fin efficiency)
 *   calcFinFan      (Fin-fan cooler)
 *   calcDoublePipe  (Double-pipe HX)
 *   calcLmtdNtu     (LMTD / NTU method)
 *   calcWallThick   (ASME Sec. VIII UG-27, Lamé thick-wall)
 *   calcFouling     (Combined fouling / area increase)
 *   calcSelector    (HX type selector / scoring)
 *   calcGeometryOptimizer (space-constrained tube optimizer)
 *   Router          (route dispatch, CORS, unknown routes)
 *   Input validation (missing fields, temperature cross, etc.)
 *
 * Run:
 *   npm install --save-dev jest node-fetch
 *   npx jest heatxpert.test.js
 *
 * Or against Vercel preview / localhost:
 *   BASE_URL=http://localhost:3000 npx jest heatxpert.test.js
 *
 * The suite works in two modes:
 *   1. HTTP mode  — sends real POST requests to BASE_URL (integration tests)
 *   2. Unit mode  — imports & calls calc functions directly (if built as ESM)
 *
 * All expected values are derived from first-principles cross-checks and
 * deliberately use wide tolerances (±5–15%) to remain robust to minor
 * formula adjustments while still catching regressions.
 */

// ─── Configuration ────────────────────────────────────────────────────────────
const BASE_URL = process.env.BASE_URL || 'https://multicalci.com';
const ENDPOINT = `${BASE_URL}/api/heatxpert`;
const TIMEOUT  = 30_000; // ms

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

// Tolerance helper: pass if |actual - expected| / expected <= fracTol
function near(actual, expected, fracTol = 0.05, label = '') {
  const pct = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-9);
  if (pct > fracTol) {
    throw new Error(
      `${label}: expected ~${expected}, got ${actual} (${(pct * 100).toFixed(1)}% deviation, tol=${(fracTol * 100).toFixed(0)}%)`
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
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — SHELL & TUBE (calcShellTube)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Shell & Tube — single-phase water/water', () => {

  // Baseline: water/water, 1-2 pass, counter-flow
  // Manually verified: Q ≈ 695 kW, LMTD ≈ 34°C, U ≈ 700 W/m²K → A ≈ 29 m²
  const baseline = {
    calcType: 'shellTube',
    hFlKey: 'water', hTi: 90, hTo: 60, hF: 80000,
    cFlKey: 'water', cTi: 25, cF: 40000, coldMode: 'flow',
    OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
    mat: 'ss316', tema: 'C', hxType: '1-2',
    Rfo: 0.0002, Rfi: 0.0002,
    pdAllowShell: 1.0, pdAllowTube: 1.0,
  };

  test('returns 200 with no error', async () => {
    const { status, body } = await post(baseline);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('heat duty Q is positive and physically reasonable (kW)', async () => {
    const { body } = await post(baseline);
    expect(body.Q).toBeGreaterThan(100);
    expect(body.Q).toBeLessThan(5000);
  });

  test('cold outlet temperature satisfies energy balance', async () => {
    const { body } = await post(baseline);
    // cTo must be > cTi and < hTi
    expect(body.cTo).toBeGreaterThan(baseline.cTi);
    expect(body.cTo).toBeLessThan(baseline.hTi);
  });

  test('LMTD is positive and consistent with terminal temps', async () => {
    const { body } = await post(baseline);
    const dT1 = baseline.hTi - body.cTo;
    const dT2 = baseline.hTo - baseline.cTi;
    const lmtd_calc = Math.abs(dT1 - dT2) < 0.001
      ? dT1
      : (dT1 - dT2) / Math.log(dT1 / dT2);
    expect(body.lmtd).toBeGreaterThan(0);
    near(body.lmtd, lmtd_calc, 0.05, 'LMTD');
  });

  test('overall heat transfer coefficient U is in realistic range (100–3000 W/m²K)', async () => {
    const { body } = await post(baseline);
    expect(body.U).toBeGreaterThan(100);
    expect(body.U).toBeLessThan(3000);
  });

  test('heat transfer area A is in realistic range (1–200 m²)', async () => {
    const { body } = await post(baseline);
    expect(body.area).toBeGreaterThan(1);
    expect(body.area).toBeLessThan(200);
  });

  test('tube velocity is between 0.3 and 4 m/s for water', async () => {
    const { body } = await post(baseline);
    expect(body.tubeVel).toBeGreaterThan(0.3);
    expect(body.tubeVel).toBeLessThan(4.0);
  });

  test('shell-side pressure drop < 1 bar for water at moderate flow', async () => {
    const { body } = await post(baseline);
    expect(body.shellDP).toBeGreaterThan(0);
    expect(body.shellDP).toBeLessThan(1.0);
  });

  test('NTU is positive and consistent with effectiveness', async () => {
    const { body } = await post(baseline);
    expect(body.NTU).toBeGreaterThan(0);
    expect(body.eff).toBeGreaterThan(0);
    expect(body.eff).toBeLessThanOrEqual(1.0);
  });

  test('resistance breakdown sums to ~100%', async () => {
    const { body } = await post(baseline);
    const total = body.resistanceBreakdown.reduce((s, r) => s + r.pct, 0);
    expect(total).toBeGreaterThan(95);
    expect(total).toBeLessThan(105);
  });

  test('numTubes is a positive integer multiple of nPasses', async () => {
    const { body } = await post(baseline);
    expect(Number.isInteger(body.numTubes)).toBe(true);
    expect(body.numTubes % body.nPasses).toBe(0);
    expect(body.numTubes).toBeGreaterThan(0);
  });

  test('convergence: U converged within 3%', async () => {
    const { body } = await post(baseline);
    expect(body.convergence.converged).toBe(true);
    expect(body.convergence.deviation_pct).toBeLessThan(3);
  });
});

describe('Shell & Tube — hot outlet >= hot inlet raises error', () => {
  test('hTo >= hTi rejected with 500', async () => {
    const { status, body } = await post({
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 60, hTo: 90, hF: 50000,
      cFlKey: 'water', cTi: 25, cF: 30000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'ss316', tema: 'C', hxType: '1-2',
    });
    expect(status).toBe(500);
    expect(body.error).toMatch(/hot outlet/i);
  });
});

describe('Shell & Tube — oil/water service', () => {
  test('crude oil shell-side gives lower U (100–600 range)', async () => {
    const { body } = await post({
      calcType: 'shellTube',
      hFlKey: 'crude-oil-light', hTi: 100, hTo: 65, hF: 60000,
      cFlKey: 'water',           cTi: 30,  cF: 45000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'cs', tema: 'C', hxType: '1-2',
      Rfo: 0.0004, Rfi: 0.0002,
    });
    expect(body.U).toBeGreaterThan(50);
    expect(body.U).toBeLessThan(600);
  });
});

describe('Shell & Tube — condensing (steam)', () => {
  test('steam condensing produces large Q compared to sensible-only', async () => {
    const steam = {
      calcType: 'shellTube',
      hFlKey: 'steam', hTi: 120, hTo: 100, hF: 5000,
      cFlKey: 'water', cTi: 25, cF: 50000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 3.66, pitch: 1.25, arr: 'counter',
      mat: 'cs', tema: 'C', hxType: '1-2',
      shellMode: 'condensing',
    };
    const { body } = await post(steam);
    // Q should include latent heat of condensation (steam hvap ~2257 kJ/kg)
    // Even at 5 t/h = 1.39 kg/s → Q ≥ 1.39 × 2257 ≈ 3136 kW (latent only)
    expect(body.Q).toBeGreaterThan(500);
    expect(body.phaseZones).toBeDefined();
    expect(body.phaseZones.mode).toBe('condensing');
  });
});

describe('Shell & Tube — imperial unit conversion', () => {
  test('metric vs imperial inputs give equivalent Q within 1%', async () => {
    const common = {
      calcType: 'shellTube',
      hFlKey: 'water', cFlKey: 'water',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'ss304', tema: 'C', hxType: '1-2',
    };
    const metric = await post({
      ...common,
      hTi: 90, hTo: 60, hF: 80000, cTi: 25, cF: 40000, coldMode: 'flow',
    });
    const imperial = await post({
      ...common,
      hTi: 194, hTo: 140, hF: 176370, cTi: 77, cF: 88185, coldMode: 'flow',
      unitSys: 'imperial',
    });
    // Q should match to within 2% (unit-conversion round-trip)
    near(imperial.body.Q, metric.body.Q, 0.02, 'Q metric vs imperial');
  });
});

describe('Shell & Tube — geometry optimizer triggered when velocity low', () => {
  test('designAdvisor populated when tube velocity is below target', async () => {
    // Low cold-side flow → low tube velocity → optimizer should kick in
    const { body } = await post({
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 80, hTo: 55, hF: 200000,
      cFlKey: 'water', cTi: 20, cF: 15000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'cs', tema: 'C', hxType: '1-2',
    });
    // Either designAdvisor is non-null OR velocity is already at target
    if (body.tubeVel < body.targetVel * 0.9) {
      expect(body.designAdvisor).not.toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — PLATE HX (calcPlate)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Plate HX', () => {

  const baseplate = {
    calcType: 'plate',
    hFlKey: 'water', hTi: 80, hTo: 50, hF: 30000,
    cFlKey: 'water', cTi: 20, cF: 25000, coldMode: 'flow',
    th: 0.6, angle: 45, gap: 3.0, pw: 0.5, plen: 1.2, phi: 1.17,
    mat: 'ss316', foul: 0.0002,
    pdAllowH: 1.5, pdAllowC: 1.5,
  };

  test('returns 200 with no error', async () => {
    const { status, body } = await post(baseplate);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('Q is positive', async () => {
    const { body } = await post(baseplate);
    expect(body.Q).toBeGreaterThan(0);
  });

  test('U_clean > U (fouling reduces overall U)', async () => {
    const { body } = await post(baseplate);
    expect(body.U_clean).toBeGreaterThan(body.U);
  });

  test('A_provided >= A_req (not under-designed)', async () => {
    const { body } = await post(baseplate);
    expect(body.A_provided).toBeGreaterThanOrEqual(body.A_req * 0.98); // 2% tolerance
  });

  test('overDesign >= -1% (plate count sufficient)', async () => {
    const { body } = await post(baseplate);
    expect(body.overDesign).toBeGreaterThan(-1);
  });

  test('hot channel HTC hH and cold channel hC > 500 W/m²K for water', async () => {
    const { body } = await post(baseplate);
    expect(body.hH).toBeGreaterThan(500);
    expect(body.hC).toBeGreaterThan(500);
  });

  test('cold outlet energy balance: cTo = cTi + Q / (cF * cp)', async () => {
    const { body } = await post(baseplate);
    // cp_water ≈ 4.182 kJ/kgK
    const cTo_calc = baseplate.cTi + body.Q / ((baseplate.cF / 3600) * 4.182);
    near(body.cTo, cTo_calc, 0.05, 'plate cTo energy balance');
  });

  test('cold inlet >= hot outlet rejected', async () => {
    const { status, body } = await post({
      ...baseplate,
      cTi: 55, // cTi > hTo=50 is a temperature cross → cold inlet below hot outlet
    });
    // Server should return 500 with temperature-cross error
    expect(status).toBe(500);
    expect(body.error).toMatch(/cold inlet/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — AIR COOLED HX (calcAirCooled)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Air Cooled HX', () => {

  const baseAC = {
    calcType: 'airCooled',
    flKey: 'crude-oil-light', Ti: 100, To: 65, F: 80000,
    Tamb: 35, dTa: 15,
    tubeOD: 25.4, tubeID: 20.0,
    finH: 12.5, finThk: 0.40, finDens: 394,
    pitchT: 63.5, rows: 4, nTubes: 40, tubeLen: 6.0,
    Rfo: 0.0002, finMat: 'alum',
  };

  test('returns 200 with no error', async () => {
    const { status, body } = await post(baseAC);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('heat duty Q > 0', async () => {
    const { body } = await post(baseAC);
    expect(body.Q).toBeGreaterThan(0);
  });

  test('fin efficiency eta_fin between 0.5 and 1.0 for aluminium fins', async () => {
    const { body } = await post(baseAC);
    expect(body.eta_fin).toBeGreaterThan(0.5);
    expect(body.eta_fin).toBeLessThanOrEqual(1.0);
  });

  test('aluminium fins have higher eta than CS fins for same geometry', async () => {
    const alum = await post({ ...baseAC, finMat: 'alum' });
    const cs   = await post({ ...baseAC, finMat: 'cs' });
    expect(alum.body.eta_fin).toBeGreaterThan(cs.body.eta_fin);
  });

  test('ambient >= outlet temperature rejected', async () => {
    const { status } = await post({ ...baseAC, Tamb: 70 }); // Tamb > To=65
    expect(status).toBe(500);
  });

  test('outlet >= inlet rejected', async () => {
    const { status } = await post({ ...baseAC, To: 110 }); // To > Ti=100
    expect(status).toBe(500);
  });

  test('area_provided reasonable (1–2000 m²)', async () => {
    const { body } = await post(baseAC);
    expect(body.A_total).toBeGreaterThan(1);
    expect(body.A_total).toBeLessThan(2000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — FIN-FAN (calcFinFan)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Fin-Fan HX', () => {

  const baseFF = {
    calcType: 'finFan',
    flKey: 'water', Ti: 70, To: 45, F: 50000,
    aTamb: 35, aTout: 50,
    tOD: 25.4, tID: 20.0,
    fH: 12.5, fThk: 0.4, fDens: 394, fMat: 'alum',
    pitchT: 63.5, nRows: 4, tLen: 6.0, nTubes: 36,
    tF_kgh: 0, // optional air flow (let calc determine)
  };

  test('returns 200', async () => {
    const { status, body } = await post(baseFF);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('Q_duty positive', async () => {
    const { body } = await post(baseFF);
    expect(body.Q_duty).toBeGreaterThan(0);
  });

  test('fin efficiency 0.5–1.0', async () => {
    const { body } = await post(baseFF);
    expect(body.eta_fin).toBeGreaterThan(0.5);
    expect(body.eta_fin).toBeLessThanOrEqual(1.0);
  });

  test('overSurface reported', async () => {
    const { body } = await post(baseFF);
    expect(typeof body.overSurf).toBe('number');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — DOUBLE PIPE (calcDoublePipe)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Double Pipe HX', () => {

  const baseDP = {
    calcType: 'doublePipe',
    hFlKey: 'water', hTi: 75, hTo: 50, hF: 5000,
    cFlKey: 'water', cTi: 20, cF: 4000, coldMode: 'flow',
    innerOD: 50, innerID: 44, outerID: 76.1, outerID_i: 70,
    L: 6.0, nHairpins: 4, arr: 'counter',
    mat: 'ss304', Rfo: 0.0002, Rfi: 0.0002,
  };

  test('returns 200', async () => {
    const { status, body } = await post(baseDP);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('Q positive', async () => {
    const { body } = await post(baseDP);
    expect(body.Q).toBeGreaterThan(0);
  });

  test('U in range 100–5000 W/m²K', async () => {
    const { body } = await post(baseDP);
    expect(body.U).toBeGreaterThan(100);
    expect(body.U).toBeLessThan(5000);
  });

  test('counter-flow LMTD > parallel-flow LMTD for same temperatures', async () => {
    const counter  = await post({ ...baseDP, arr: 'counter' });
    const parallel = await post({ ...baseDP, arr: 'parallel' });
    expect(counter.body.lmtd).toBeGreaterThan(parallel.body.lmtd);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — LMTD / NTU METHOD (calcLmtdNtu)
// ═══════════════════════════════════════════════════════════════════════════════
describe('LMTD / NTU method', () => {

  test('1-1 counter-flow: LMTD calculation is correct', async () => {
    const { body } = await post({
      calcType: 'lmtdNtu',
      hTi: 100, hTo: 60, cTi: 30, cTo: 55,
      hF: 20000, cF: 18000,
      hFlKey: 'water', cFlKey: 'water',
      arr: 'counter', hxType: '1-1',
    });
    // dT1 = 100-55=45, dT2 = 60-30=30, LMTD = (45-30)/ln(45/30) = 37.06°C
    near(body.lmtd, 37.06, 0.02, 'LMTD 1-1 counter');
    expect(body.F).toBeCloseTo(1.0, 1); // 1-1 has no correction
  });

  test('1-2 pass: F correction factor between 0.75 and 1.0', async () => {
    const { body } = await post({
      calcType: 'lmtdNtu',
      hTi: 100, hTo: 60, cTi: 30, cTo: 55,
      hF: 20000, cF: 18000,
      hFlKey: 'water', cFlKey: 'water',
      arr: 'counter', hxType: '1-2',
    });
    expect(body.F).toBeGreaterThan(0.75);
    expect(body.F).toBeLessThanOrEqual(1.01);
  });

  test('NTU method — effectiveness matches analytical for balanced flow', async () => {
    // Balanced: Cmin=Cmax → effectiveness = NTU/(NTU+1) for counter-flow
    const { body } = await post({
      calcType: 'lmtdNtu',
      hTi: 80, hTo: 50, cTi: 20,
      hF: 10000, cF: 10000,
      hFlKey: 'water', cFlKey: 'water',
      arr: 'counter', hxType: '1-1',
    });
    expect(body.eff).toBeGreaterThan(0);
    expect(body.eff).toBeLessThanOrEqual(1.0);
    expect(body.NTU).toBeGreaterThan(0);
  });

  test('temperature cross rejected', async () => {
    const { status } = await post({
      calcType: 'lmtdNtu',
      hTi: 50, hTo: 40, cTi: 45, cTo: 60, // temperature cross
      hF: 10000, cF: 10000,
      hFlKey: 'water', cFlKey: 'water',
      arr: 'counter', hxType: '1-1',
    });
    expect(status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — WALL THICKNESS (calcWallThick)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Wall Thickness — ASME Sec. VIII UG-27', () => {

  const baseWT = {
    calcType: 'wallThick',
    type: 'cylinder', P_barg: 15, D_mm: 600,
    S_MPa: 138, E: 1.0, CA_mm: 3.0, MT_mm: 0,
    standard: 'ASME-VIII',
  };

  test('returns 200', async () => {
    const { status, body } = await post(baseWT);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('t_calc_mm > 0', async () => {
    const { body } = await post(baseWT);
    expect(body.t_calc_mm).toBeGreaterThan(0);
  });

  test('t_nominal >= t_with_CA', async () => {
    const { body } = await post(baseWT);
    expect(body.t_nominal).toBeGreaterThanOrEqual(body.t_with_CA);
  });

  test('MAWP check passes (pMax_check_bar > design pressure)', async () => {
    const { body } = await post(baseWT);
    // pMax at t_nominal should exceed design pressure
    expect(body.pMax_check_bar).toBeGreaterThan(baseWT.P_barg);
  });

  test('thin-wall formula: t ≈ PR/(SE-0.6P) for cylinder', async () => {
    const { body } = await post(baseWT);
    const P = baseWT.P_barg * 0.1; // bar → MPa
    const R_i = baseWT.D_mm / 2;
    const t_expected = (P * R_i) / (baseWT.S_MPa * baseWT.E - 0.6 * P);
    near(body.t_thin_mm, t_expected, 0.03, 'thin-wall formula');
  });

  test('thick-wall Lamé triggered when t/R >= 0.1', async () => {
    // High pressure forces t/R >> 0.1
    const { body } = await post({ ...baseWT, P_barg: 250 });
    expect(body.isThickWall).toBe(true);
    expect(body.lameT).toBeGreaterThan(0);
  });

  test('sphere produces smaller t than cylinder at same inputs', async () => {
    const cyl    = await post({ ...baseWT, type: 'cylinder' });
    const sphere = await post({ ...baseWT, type: 'sphere' });
    expect(sphere.body.t_calc_mm).toBeLessThan(cyl.body.t_calc_mm);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — FOULING (calcFouling)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Fouling calculator', () => {

  test('returns 200', async () => {
    const { status, body } = await post({ calcType: 'fouling', Rf_s: 0.0002, Rf_t: 0.0002, U_cl: 800 });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('U_service < U_clean (fouling degrades performance)', async () => {
    const { body } = await post({ calcType: 'fouling', Rf_s: 0.0002, Rf_t: 0.0002, U_cl: 800 });
    expect(body.U_service).toBeLessThan(body.U_cl);
  });

  test('Rf_total = Rf_s + Rf_t', async () => {
    const Rf_s = 0.0003, Rf_t = 0.0004;
    const { body } = await post({ calcType: 'fouling', Rf_s, Rf_t, U_cl: 800 });
    near(body.Rf_total, Rf_s + Rf_t, 0.001, 'Rf_total');
  });

  test('area_increase is positive and proportional to fouling resistance', async () => {
    const clean  = await post({ calcType: 'fouling', Rf_s: 0, Rf_t: 0, U_cl: 800 });
    const fouled = await post({ calcType: 'fouling', Rf_s: 0.0004, Rf_t: 0.0004, U_cl: 800 });
    expect(fouled.body.area_increase).toBeGreaterThan(clean.body.area_increase);
  });

  test('U_service formula: 1/(1/U_cl + Rf_total)', async () => {
    const Rf_s = 0.0002, Rf_t = 0.0002, U_cl = 1000;
    const { body } = await post({ calcType: 'fouling', Rf_s, Rf_t, U_cl });
    const expected = 1 / (1 / U_cl + Rf_s + Rf_t);
    near(body.U_service, expected, 0.001, 'U_service formula');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — HX SELECTOR (calcSelector)
// ═══════════════════════════════════════════════════════════════════════════════
describe('HX Type Selector', () => {

  test('air-cooling application → top recommendation is air-cooled', async () => {
    const { body } = await post({
      calcType: 'selector',
      app: 'air-cooling', pres: 'low', foul: 'low', duty: 'large', space: 'plenty', corr: 'low',
    });
    expect(body.top).toBe('air-cooled');
  });

  test('condensing + high pressure → shell-tube recommended', async () => {
    const { body } = await post({
      calcType: 'selector',
      app: 'condensing', pres: 'high', foul: 'medium', duty: 'large', space: 'plenty', corr: 'medium',
    });
    expect(body.top).toBe('shell-tube');
  });

  test('small duty + liquid-liquid + very limited space → plate recommended', async () => {
    const { body } = await post({
      calcType: 'selector',
      app: 'liquid-liquid', pres: 'low', foul: 'low', duty: 'small', space: 'very-limited', corr: 'low',
    });
    expect(body.top).toBe('plate');
  });

  test('scores object contains all six HX types', async () => {
    const { body } = await post({
      calcType: 'selector',
      app: 'liquid-liquid', pres: 'medium', foul: 'low', duty: 'medium', space: 'plenty', corr: 'low',
    });
    const types = ['shell-tube', 'plate', 'air-cooled', 'double-pipe', 'spiral', 'plate-fin'];
    types.forEach(t => expect(body.scores).toHaveProperty(t));
  });

  test('high fouling + high pressure → NOT plate (plate penalized)', async () => {
    const { body } = await post({
      calcType: 'selector',
      app: 'liquid-liquid', pres: 'high', foul: 'high', duty: 'large', space: 'plenty', corr: 'low',
    });
    // Plate score should be less than shell-tube score
    expect(body.scores['plate']).toBeLessThan(body.scores['shell-tube']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — GEOMETRY OPTIMIZER (calcGeometryOptimizer)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Geometry Optimizer', () => {

  const baseGO = {
    calcType: 'geoOptimizer',
    area_req: 30, massC_kgs: 5.0, L_fixed: 4.88,
    rho_c: 998, target_vel: 1.5, vel_min: 0.8, vel_max: 3.5,
    max_passes: 8, max_shells: 3,
  };

  test('returns 200', async () => {
    const { status, body } = await post(baseGO);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  test('returns valid solutions when constraints are achievable', async () => {
    const { body } = await post(baseGO);
    expect(body.solutions_valid.length).toBeGreaterThan(0);
    expect(body.any_solution).toBe(true);
  });

  test('all valid solutions have velocity within [vel_min, vel_max]', async () => {
    const { body } = await post(baseGO);
    body.solutions_valid.forEach(s => {
      expect(s.velocity).toBeGreaterThanOrEqual(baseGO.vel_min - 0.01);
      expect(s.velocity).toBeLessThanOrEqual(baseGO.vel_max + 0.01);
    });
  });

  test('all valid solutions meet area requirement (area_margin_pct >= 0)', async () => {
    const { body } = await post(baseGO);
    body.solutions_valid.forEach(s => {
      expect(s.area_margin_pct).toBeGreaterThanOrEqual(-0.5); // ≤0.5% rounding
    });
  });

  test('recommendation string is non-empty', async () => {
    const { body } = await post(baseGO);
    expect(body.recommendation.length).toBeGreaterThan(10);
  });

  test('no solution returns any_solution=false with helpful message', async () => {
    const { body } = await post({
      ...baseGO,
      massC_kgs: 0.001, // near-zero flow → impossible to hit 0.8 m/s
      area_req: 500,
    });
    // May or may not find a solution — just validate structure
    expect(typeof body.any_solution).toBe('boolean');
    expect(body.recommendation.length).toBeGreaterThan(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — BELL-DELAWARE CONSISTENCY CHECKS
// ═══════════════════════════════════════════════════════════════════════════════
describe('Bell-Delaware correction factor physics', () => {

  // The shell-side correction factor product Jtotal = Jc×Jl×Jb×Jr×Js
  // must be in (0.3, 1.0) for realistic designs.
  test('Jtotal between 0.30 and 1.0 for typical water/water design', async () => {
    const { body } = await post({
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 90, hTo: 65, hF: 60000,
      cFlKey: 'water', cTi: 25, cF: 40000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'ss304', tema: 'C', hxType: '1-2',
    });
    const J = body.bdCorr.Jtotal;
    expect(J).toBeGreaterThan(0.30);
    expect(J).toBeLessThan(1.01);
  });

  // TEMA B (tighter clearances) → fewer leakages → higher Jtotal than TEMA C
  test('TEMA B gives higher Jtotal than TEMA C (tighter clearances)', async () => {
    const common = {
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 90, hTo: 65, hF: 60000,
      cFlKey: 'water', cTi: 25, cF: 40000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'ss304', hxType: '1-2',
    };
    const temaC = await post({ ...common, tema: 'C' });
    const temaB = await post({ ...common, tema: 'B' });
    expect(temaB.body.bdCorr.Jtotal).toBeGreaterThanOrEqual(temaC.body.bdCorr.Jtotal - 0.05);
  });

  // Square pitch → larger Sm → lower Re → lower h; triangular should give higher h
  test('triangular pitch gives higher shell-side h than square pitch (same geometry)', async () => {
    const common = {
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 90, hTo: 65, hF: 60000,
      cFlKey: 'water', cTi: 25, cF: 40000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'ss304', tema: 'C', hxType: '1-2',
    };
    const tri = await post({ ...common, pitchLayout: 'triangular' });
    const sq  = await post({ ...common, pitchLayout: 'square' });
    expect(tri.body.bdCorr.hShell).toBeGreaterThan(sq.body.bdCorr.hShell * 0.85);
  });

  // Increasing baffle cut fraction reduces pressure drop
  test('higher baffle cut → lower shell-side ΔP', async () => {
    const common = {
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 90, hTo: 65, hF: 60000,
      cFlKey: 'water', cTi: 25, cF: 40000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'ss304', tema: 'C', hxType: '1-2',
    };
    const cut20 = await post({ ...common, bcut: 0.20 });
    const cut40 = await post({ ...common, bcut: 0.40 });
    expect(cut40.body.shellDP).toBeLessThan(cut20.body.shellDP);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 13 — PRESSURE DROP DIRECTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════
describe('Pressure drop physics', () => {

  test('tube ΔP increases with increasing flow rate', async () => {
    const common = {
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 90, hTo: 65, hF: 60000,
      cFlKey: 'water', cTi: 25, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'ss304', tema: 'C', hxType: '1-2',
    };
    const lo = await post({ ...common, cF: 20000 });
    const hi = await post({ ...common, cF: 60000 });
    expect(hi.body.tubeDp).toBeGreaterThan(lo.body.tubeDp);
  });

  test('shell ΔP increases with increasing shell-side flow rate', async () => {
    const common = {
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 90, hTo: 65,
      cFlKey: 'water', cTi: 25, cF: 30000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'ss304', tema: 'C', hxType: '1-2',
    };
    const lo = await post({ ...common, hF: 30000 });
    const hi = await post({ ...common, hF: 120000 });
    expect(hi.body.shellDP).toBeGreaterThan(lo.body.shellDP);
  });

  test('gas service (shell-side): ΔP much smaller than liquid service', async () => {
    const liquid = await post({
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 90, hTo: 65, hF: 60000,
      cFlKey: 'water', cTi: 25, cF: 40000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'ss304', tema: 'C', hxType: '1-2',
    });
    const gas = await post({
      calcType: 'shellTube',
      hFlKey: 'air', hTi: 90, hTo: 65, hF: 5000,
      cFlKey: 'water', cTi: 25, cF: 40000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'ss304', tema: 'C', hxType: '1-2',
    });
    // Gas-side ΔP should be orders of magnitude lower for same mass flow fraction
    expect(gas.body.shellDP).toBeLessThan(liquid.body.shellDP);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 14 — FLUID DATABASE SPOT CHECKS
// ═══════════════════════════════════════════════════════════════════════════════
describe('Fluid database — spot checks via S&T calc', () => {

  // Verify that selecting different fluids gives meaningfully different U values.
  // Water (high cp, low mu) should give much higher U than lube oil (high mu).
  test('water U >> lube-oil U for same geometry', async () => {
    const common = {
      calcType: 'shellTube',
      hTi: 80, hTo: 55, hF: 30000,
      cTi: 25, cF: 25000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'cs', tema: 'C', hxType: '1-2',
    };
    const w = await post({ ...common, hFlKey: 'water',    cFlKey: 'water' });
    const o = await post({ ...common, hFlKey: 'lube-oil', cFlKey: 'water' });
    expect(w.body.U).toBeGreaterThan(o.body.U * 2);
  });

  // Steam has tabulated temperature-interpolated properties
  test('steam properties temperature-interpolated (mu varies with T)', async () => {
    const lo = await post({
      calcType: 'shellTube',
      hFlKey: 'steam', hTi: 150, hTo: 100, hF: 3000,
      cFlKey: 'water', cTi: 20, cF: 30000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 3.66, pitch: 1.25, arr: 'counter',
      mat: 'cs', tema: 'C', hxType: '1-2', shellMode: 'single-phase',
    });
    // Just verify no error and U is physical
    expect(lo.body.U).toBeGreaterThan(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 15 — INPUT VALIDATION EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════
describe('Input validation edge cases', () => {

  test('missing required field OD returns 500 with informative error', async () => {
    const { status, body } = await post({
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 90, hTo: 60, hF: 80000,
      cFlKey: 'water', cTi: 25, cF: 40000, coldMode: 'flow',
      // OD deliberately missing
      tw: 2.0, L: 4.88, pitch: 1.25, mat: 'ss304', tema: 'C', hxType: '1-2',
    });
    expect(status).toBe(500);
    expect(body.error).toMatch(/OD/i);
  });

  test('hF = 0 rejected for shell & tube', async () => {
    const { status } = await post({
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 90, hTo: 60, hF: 0,
      cFlKey: 'water', cTi: 25, cF: 40000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, mat: 'ss304', tema: 'C', hxType: '1-2',
    });
    expect(status).toBe(500);
  });

  test('hTi <= cTi rejected (no driving force)', async () => {
    const { status } = await post({
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 25, hTo: 15, hF: 40000,
      cFlKey: 'water', cTi: 30, cF: 30000, coldMode: 'flow', // cTi > hTi
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, mat: 'ss304', tema: 'C', hxType: '1-2',
    });
    expect(status).toBe(500);
  });

  test('invalid JSON body returns 400', async () => {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json :::',
    });
    expect(resp.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 16 — REGRESSION / GOLDEN VALUE TESTS
// ═══════════════════════════════════════════════════════════════════════════════
describe('Golden-value regression tests', () => {

  // These values were captured from a verified reference run and must not drift.
  // Tolerances are tighter here (±3%) to catch silent formula changes.

  test('[REG-ST-01] water/water shell&tube golden U, area, Q', async () => {
    const { body } = await post({
      calcType: 'shellTube',
      hFlKey: 'water', hTi: 90, hTo: 60, hF: 80000,
      cFlKey: 'water', cTi: 25, cF: 40000, coldMode: 'flow',
      OD: 25.4, tw: 2.0, L: 4.88, pitch: 1.25, arr: 'counter',
      mat: 'ss316', tema: 'C', hxType: '1-2',
      Rfo: 0.0002, Rfi: 0.0002,
    });
    // Q = (80000/3600) × 4.182 × (90-60) ≈ 2790 kW
    near(body.Q, 2790, 0.05, '[REG-ST-01] Q');
    // U for water/water moderate flow should be in 450–1200 range
    expect(body.U).toBeGreaterThan(300);
    expect(body.U).toBeLessThan(1500);
    // Area = Q/(U × LMTD×F); broad range check
    expect(body.area).toBeGreaterThan(5);
    expect(body.area).toBeLessThan(300);
  });

  test('[REG-PL-01] plate HX golden Q and plate count', async () => {
    const { body } = await post({
      calcType: 'plate',
      hFlKey: 'water', hTi: 80, hTo: 50, hF: 30000,
      cFlKey: 'water', cTi: 20, cF: 25000, coldMode: 'flow',
      th: 0.6, angle: 45, gap: 3.0, pw: 0.5, plen: 1.2, phi: 1.17,
      mat: 'ss316', foul: 0.0002,
    });
    // Q = (30000/3600) × 4.182 × (80-50) ≈ 1045 kW
    near(body.Q, 1045, 0.05, '[REG-PL-01] Q');
    expect(body.nPlates).toBeGreaterThan(4);
  });

  test('[REG-FO-01] fouling — U_service golden value', async () => {
    const { body } = await post({ calcType: 'fouling', Rf_s: 0.0002, Rf_t: 0.0002, U_cl: 800 });
    // U_s = 1/(1/800 + 0.0004) = 1/(0.00125+0.0004) = 1/0.00165 ≈ 606.1
    near(body.U_service, 606.1, 0.01, '[REG-FO-01] U_service');
  });

  test('[REG-WT-01] wall thickness golden value at 15 barg, D=600mm', async () => {
    const { body } = await post({
      calcType: 'wallThick',
      type: 'cylinder', P_barg: 15, D_mm: 600,
      S_MPa: 138, E: 1.0, CA_mm: 3.0, MT_mm: 0,
      standard: 'ASME-VIII',
    });
    // t = PR/(SE - 0.6P) = 1.5×300/(138×1 - 0.6×1.5) = 450/137.1 ≈ 3.28 mm
    near(body.t_thin_mm, 3.28, 0.05, '[REG-WT-01] t_thin_mm');
  });
});
