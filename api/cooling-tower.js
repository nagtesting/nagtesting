// ================================================================
// api/cooling-tower.js  —  Vercel Serverless Function
// 🔐 ALL CALCULATION LOGIC RUNS ON SERVER — NEVER EXPOSED TO BROWSER
// Place this file in your GitHub repo at: /api/cooling-tower.js
// ================================================================

export default function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowed = origin.endsWith('.vercel.app') || origin === 'https://multicalci.com';
  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : 'https://multicalci.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { action, params } = req.body;
    if (!action) return res.status(400).json({ error: 'Missing action' });

    if (action === 'calculate') {
      const result = runCalculate(params);
      if (result.error) return res.status(400).json({ error: result.error });
      return res.status(200).json({ success: true, data: result });
    }

    if (action === 'predictCWT') {
      const result = runPredictCWT(params);
      if (result.error) return res.status(400).json({ error: result.error });
      return res.status(200).json({ success: true, data: result });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    return res.status(500).json({ error: 'Server calculation error: ' + err.message });
  }
}

// ================================================================
// 🔐 CORE CALCULATION ENGINE — HIDDEN ON SERVER
// ================================================================

// ── Psychrometric helpers ────────────────────────────────────────

function psat_kPa(T_C) {
  if (T_C <= 60) {
    return 0.61121 * Math.exp((18.678 - T_C / 234.5) * (T_C / (257.14 + T_C)));
  } else {
    const P_mmHg = Math.pow(10, 8.07131 - 1730.63 / (233.426 + T_C));
    return P_mmHg * 0.133322;
  }
}

function saturationEnthalpy(T_C, P_kPa) {
  const psat = psat_kPa(T_C);
  if (psat >= P_kPa) return null;
  const Ws = 0.62198 * psat / (P_kPa - psat);
  return 1.006 * T_C + Ws * (2501 + 1.805 * T_C);
}

function airEnthalpy(Twb_C, P_kPa) {
  return saturationEnthalpy(Twb_C, P_kPa);
}

function cpWater(T_C) {
  const t = T_C;
  return 4.2174 - 0.005618 * t + 1.313e-4 * t * t - 1.014e-6 * t * t * t;
}

function elevToPatm(elev_m) {
  return 101.325 * Math.pow(1 - 2.25577e-5 * elev_m, 5.25588);
}

function rhoWater(T_C) {
  return 999.842 - 0.0624 * T_C - 0.003712 * T_C * T_C;
}

function rhoAir(T_C, Patm_kPa, RH = 1.0) {
  const T_K = T_C + 273.15;
  const pv = RH * psat_kPa(T_C);
  const pd = Patm_kPa - pv;
  return (pd * 0.028964 + pv * 0.018016) / (8.314462e-3 * T_K);
}

// ── KaV/L — Adaptive Chebyshev Integration (CTI ATC-105) ────────

function kavl(cwt_C, hwt_C, wb_C, P_kPa) {
  const range = hwt_C - cwt_C;
  if (range <= 0) return null;
  const h_a = airEnthalpy(wb_C, P_kPa);
  if (h_a === null) return null;

  const fracs = range > 15
    ? [0.05, 0.15, 0.30, 0.45, 0.55, 0.70, 0.85, 0.95]
    : [0.1, 0.4, 0.6, 0.9];
  const n = fracs.length;

  let sum = 0;
  let anyPositive = false;
  for (const f of fracs) {
    const T_i = cwt_C + f * range;
    const h_si = saturationEnthalpy(T_i, P_kPa);
    if (h_si === null) continue;
    const dh = h_si - h_a;
    if (dh < 0.01) continue;
    const cp_i = cpWater(T_i);
    sum += cp_i / dh;
    anyPositive = true;
  }
  if (!anyPositive) return null;
  return (range / n) * sum;
}

// ── CTI κ (Kappa) Solver ─────────────────────────────────────────

function solveCWT(target_kavl, hwt_C, wb_C, P_kPa) {
  let lo = wb_C + 0.01, hi = hwt_C - 0.01;
  if (lo >= hi) return { cwt: null, converged: false };
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const k = kavl(mid, hwt_C, wb_C, P_kPa);
    if (k === null) { lo = mid; continue; }
    if (k > target_kavl) lo = mid; else hi = mid;
    if (hi - lo < 1e-6) break;
  }
  const cwt = (lo + hi) / 2;
  const k_check = kavl(cwt, hwt_C, wb_C, P_kPa);
  const converged = k_check !== null && Math.abs(k_check - target_kavl) / target_kavl < 0.001;
  return { cwt, converged };
}

function computeKappa(cwt_d_C, hwt_d_C, wb_d_C, P_kPa) {
  const kavl_d = kavl(cwt_d_C, hwt_d_C, wb_d_C, P_kPa);
  if (!kavl_d || kavl_d <= 0) return null;

  const approach = cwt_d_C - wb_d_C;
  const delta = Math.max(0.1, Math.min(1.0, approach * 0.03));

  const r_plus = solveCWT(kavl_d, hwt_d_C, wb_d_C + delta, P_kPa);
  const r_minus = solveCWT(kavl_d, hwt_d_C, wb_d_C - delta, P_kPa);

  if (r_plus.cwt === null || r_minus.cwt === null) return null;
  if (!r_plus.converged || !r_minus.converged) return null;

  const kappa = (r_plus.cwt - r_minus.cwt) / (2 * delta);
  if (kappa <= 0 || kappa > 1.5) return null;
  return kappa;
}

function calcPredictedCWT(cwt_d, wb_d, wb_a, kappa) {
  return cwt_d + kappa * (wb_a - wb_d);
}

// ── Status Assessments ───────────────────────────────────────────

function approachSt(dAppVsPred_C, thW_C, thB_C) {
  if (dAppVsPred_C <= 0)       return { cls: 'ok',   lbl: 'ON PREDICTION', icon: '✅', t: 'Actual approach at or better than κ-predicted Merkel value. Tower performing to specification.' };
  if (dAppVsPred_C <= 0.5)     return { cls: 'ok',   lbl: 'ACCEPTABLE',    icon: '✅', t: 'Within ±0.5°C of Merkel prediction. Monitor trend — no immediate action.' };
  if (dAppVsPred_C <= thW_C)   return { cls: 'ok',   lbl: 'ACCEPTABLE',    icon: '✅', t: 'Within warning band of Merkel prediction. Increase monitoring frequency. Check water chemistry and distribution headers.' };
  if (dAppVsPred_C <= thB_C)   return { cls: 'warn', lbl: 'DEGRADED',      icon: '⚠️', t: 'Actual approach exceeds κ-predicted value beyond warning threshold. Inspect: fill media, nozzles, louvres, drift eliminators, and fan. Schedule maintenance.' };
  return                              { cls: 'bad',  lbl: 'CRITICAL',      icon: '🔴', t: 'Actual approach far exceeds Merkel prediction — critical degradation. Likely causes: fill fouling/scaling, blocked nozzles, draft failure. Immediate inspection required.' };
}

function lgSt(lg) {
  if (lg < 0.6)  return { cls: 'bad',  lbl: 'VERY LOW', icon: '🔴', t: 'Unusually low L/G. Check pump operation, valve positions, basin level, and flow meter calibration.' };
  if (lg < 0.75) return { cls: 'warn', lbl: 'LOW',      icon: '⚠️', t: 'Below typical range. Verify pump impeller, strainer condition, and water distribution headers.' };
  if (lg <= 1.5) return { cls: 'ok',   lbl: 'NORMAL',   icon: '✅', t: 'L/G within typical operating range (0.75–1.5) for counterflow/crossflow towers.' };
  if (lg <= 2.0) return { cls: 'warn', lbl: 'HIGH',     icon: '⚠️', t: 'High L/G — water dominates. Check fan blade pitch, motor speed, belt/drive system, or air-side obstructions.' };
  return               { cls: 'bad',  lbl: 'VERY HIGH', icon: '🔴', t: 'Very high L/G. Significant air-side deficiency. Immediate fan/mechanical draft investigation required.' };
}

function fillStatus(pct) {
  if (pct === null || isNaN(pct)) return { cls: 'info', lbl: 'N/A',      icon: '—',  t: 'Cannot compute fill efficiency — verify all inputs.', bar: 'am' };
  if (pct >= 95)  return { cls: 'ok',   lbl: 'GOOD',     icon: '✅', t: 'Fill operating at or near design specification (≥95%). No immediate action required.', bar: 'gn' };
  if (pct >= 80)  return { cls: 'warn', lbl: 'DEGRADED',  icon: '⚠️', t: 'Fill partially degraded (80–95%). Schedule inspection: check for scaling, biological fouling, sagging or collapsed blocks.', bar: 'am' };
  if (pct >= 60)  return { cls: 'bad',  lbl: 'POOR',      icon: '🔴', t: 'Fill severely degraded (60–80%). Urgent inspection required. Likely causes: heavy fouling, scaling, structural damage.', bar: 'rd' };
  return                { cls: 'bad',  lbl: 'CRITICAL',   icon: '🔴', t: 'Fill critically degraded (<60%). Tower cannot meet design duty. Immediate shutdown for inspection and fill replacement required.', bar: 'rd' };
}

function perfScore(app_a, pred_app, fillPct, lg) {
  // Approach score (50 pts)
  const dApp = app_a - pred_app;
  let appScore;
  if (dApp <= 0) appScore = 50;
  else if (dApp <= 0.5) appScore = 45;
  else if (dApp <= 1.5) appScore = 35;
  else if (dApp <= 3.0) appScore = 20;
  else appScore = 5;

  // Fill score (35 pts)
  let fillScore;
  if (fillPct === null) fillScore = 20;
  else if (fillPct >= 95) fillScore = 35;
  else if (fillPct >= 80) fillScore = 25;
  else if (fillPct >= 60) fillScore = 12;
  else fillScore = 3;

  // L/G score (15 pts)
  let lgScore;
  if (lg === null) lgScore = 10;
  else if (lg >= 0.75 && lg <= 1.5) lgScore = 15;
  else if (lg >= 0.6 && lg <= 2.0) lgScore = 8;
  else lgScore = 2;

  return appScore + fillScore + lgScore;
}

function scoreInfo(s) {
  if (s >= 85) return { c: '#00e676', lbl: 'EXCELLENT' };
  if (s >= 70) return { c: '#00c9a7', lbl: 'GOOD' };
  if (s >= 55) return { c: '#ffb800', lbl: 'FAIR' };
  return { c: '#ff4444', lbl: 'POOR' };
}

// ── WBT Sweep Builder ────────────────────────────────────────────

function buildWBTSweep(dWB_C, dCWT_C, dHWT_C, aWB_C, kappa, Patm_kPa) {
  const steps = [];
  for (let dT = -15; dT <= 15; dT += 1) {
    const wb = dWB_C + dT;
    const pred = calcPredictedCWT(dCWT_C, dWB_C, wb, kappa);
    const kavlV = kavl(pred, dHWT_C, wb, Patm_kPa);
    const app = pred - wb;
    steps.push({
      wb: parseFloat(wb.toFixed(1)),
      pred: parseFloat(pred.toFixed(2)),
      app: parseFloat(app.toFixed(2)),
      kavlV: kavlV !== null ? parseFloat(kavlV.toFixed(4)) : null,
      isActual: Math.abs(wb - aWB_C) < 0.05
    });
  }
  return steps;
}

// ── Main calculate handler ───────────────────────────────────────

function runCalculate(p) {
  const {
    dWB_C, dCWT_C, dHWT_C, dWR, dAR,
    aWB_C, aCWT_C, aHWT_C,
    thW_C, thB_C,
    elev, patm,
    unitSys
  } = p;

  // Determine Patm
  let Patm_kPa = 101.325;
  if (isFinite(patm) && patm > 70 && patm < 110) {
    Patm_kPa = patm;
  } else if (isFinite(elev) && elev >= 0) {
    Patm_kPa = elevToPatm(elev);
  }

  // Validation
  const errs = [];
  if (!isFinite(dWB_C) || !isFinite(aWB_C)) errs.push('WBT values must be finite.');
  if (!isFinite(dCWT_C) || !isFinite(dHWT_C)) errs.push('Design CWT and HWT must be provided.');
  if (!isFinite(aCWT_C) || !isFinite(aHWT_C)) errs.push('Actual CWT and HWT must be provided.');
  if (dCWT_C <= dWB_C) errs.push('Design CWT must be > WBT (approach must be positive).');
  if (dHWT_C <= dCWT_C) errs.push('Design HWT must be > CWT (range must be positive).');
  if (aCWT_C <= aWB_C) errs.push('Actual CWT must be > Actual WBT.');
  if (aHWT_C <= aCWT_C) errs.push('Actual HWT must be > Actual CWT.');
  if (!isFinite(dWR) || dWR <= 0) errs.push('Water flow must be positive.');
  if (dHWT_C > 80 || aHWT_C > 80) errs.push('HWT must be below 80°C — near-boiling inputs are outside the valid psychrometric range.');
  if (dWB_C < -10 || aWB_C < -10) errs.push('WBT below −10°C is outside the valid psychrometric range for evaporative cooling.');
  if (errs.length) return { error: errs.join(' | ') };

  const hasAirFlow = isFinite(dAR) && dAR > 0;
  const thW = isFinite(thW_C) ? thW_C : 1.5;
  const thB = isFinite(thB_C) ? thB_C : 3.0;

  // Core calcs
  const app_d = dCWT_C - dWB_C, app_a = aCWT_C - aWB_C;
  const rng_d = dHWT_C - dCWT_C, rng_a = aHWT_C - aCWT_C;
  const dApp = app_a - app_d, dWBT = aWB_C - dWB_C;

  const avgTw_d = (dCWT_C + dHWT_C) / 2;
  const RHO_W_d = rhoWater(avgTw_d);
  const RHO_A_site = rhoAir(aWB_C, Patm_kPa);
  const Lmass = dWR * RHO_W_d / 3600;
  const Gmass = hasAirFlow ? dAR * RHO_A_site / 3600 : null;
  const lg = hasAirFlow ? Lmass / Gmass : null;

  const kavl_d = kavl(dCWT_C, dHWT_C, dWB_C, Patm_kPa);
  const kavl_a = kavl(aCWT_C, aHWT_C, aWB_C, Patm_kPa);
  const kavl_d_norm = kavl(dCWT_C, dHWT_C, aWB_C, Patm_kPa);
  const kavl_a_norm = kavl(aCWT_C, aHWT_C, aWB_C, Patm_kPa);
  let fillPct = null;
  if (kavl_d_norm !== null && kavl_d_norm > 0 && kavl_a_norm !== null)
    fillPct = Math.min((kavl_a_norm / kavl_d_norm) * 100, 150);

  const kappa = computeKappa(dCWT_C, dHWT_C, dWB_C, Patm_kPa);
  const kappaOK = kappa !== null;
  const kappaVal = kappaOK ? kappa : 0.6;
  const pred_cwt = calcPredictedCWT(dCWT_C, dWB_C, aWB_C, kappaVal);
  const pred_app = pred_cwt - aWB_C;
  const cwtDev = aCWT_C - pred_cwt;
  const dAppVsPred = app_a - pred_app;

  const effectiveness_d = rng_d / (dHWT_C - dWB_C);
  const effectiveness_a = rng_a / (aHWT_C - aWB_C);

  const appStResult = approachSt(dAppVsPred, thW, thB);
  const lgStResult = lg !== null ? lgSt(lg) : { cls: 'info', lbl: 'N/A', icon: '—', t: 'Air flow not provided — L/G ratio not computed.' };
  const fillStResult = fillStatus(fillPct);

  const score = perfScore(app_a, pred_app, fillPct, lg);
  const sInfo = scoreInfo(score);

  const worst = fillStResult.cls === 'bad' || appStResult.cls === 'bad' ? 'bad'
    : fillStResult.cls === 'warn' || appStResult.cls === 'warn' ? 'warn' : 'ok';

  // Build sweep table data
  const sweepData = buildWBTSweep(dWB_C, dCWT_C, dHWT_C, aWB_C, kappaVal, Patm_kPa);

  // Merkel chart data points
  const chartData = buildMerkelChart(dCWT_C, dHWT_C, dWB_C, aCWT_C, aHWT_C, aWB_C, Patm_kPa);

  return {
    // Inputs (echoed back in SI °C)
    dWB: dWB_C, dCWT: dCWT_C, dHWT: dHWT_C, dWR_r: dWR, dAR_r: dAR,
    aWB: aWB_C, aCWT: aCWT_C, aHWT: aHWT_C,
    hasAirFlow,

    // Core results
    app_d, app_a, rng_d, rng_a, dApp, dWBT,
    Lmass, Gmass, lg,
    kavl_d, kavl_a, kavl_d_norm, kavl_a_norm, fillPct,
    kappa: kappaVal, kappaOK, pred_cwt, pred_app, cwtDev, dAppVsPred,
    effectiveness_d, effectiveness_a,
    Patm_kPa, RHO_W_d, RHO_A_site,
    thW_C: thW, thB_C: thB,
    appSt: appStResult, lgSt: lgStResult, fillSt: fillStResult,
    worst, score, sInfo,

    // Table/chart data
    sweepData,
    chartData,

    // Range flag for integration info
    largeRange: rng_d > 15,

    ts: new Date().toISOString()
  };
}

function buildMerkelChart(dCWT_C, dHWT_C, dWB_C, aCWT_C, aHWT_C, aWB_C, Patm_kPa) {
  // Saturation curve points
  const Tmin = Math.min(dCWT_C, aCWT_C) - 2;
  const Tmax = Math.max(dHWT_C, aHWT_C) + 2;
  const nPts = 60;
  const satCurve = [];
  for (let i = 0; i <= nPts; i++) {
    const T = Tmin + i * (Tmax - Tmin) / nPts;
    satCurve.push({ T: parseFloat(T.toFixed(2)), h: saturationEnthalpy(T, Patm_kPa) });
  }

  // Chebyshev integration points (actual)
  const range_a = aHWT_C - aCWT_C;
  const fracs = [0.1, 0.4, 0.6, 0.9];
  const h_a_actual = airEnthalpy(aWB_C, Patm_kPa);
  const chevPts = fracs.map(f => {
    const Ti = aCWT_C + f * range_a;
    const cpAvg = (cpWater(aCWT_C) + cpWater(Ti)) / 2;
    return {
      T: parseFloat(Ti.toFixed(2)),
      hs: saturationEnthalpy(Ti, Patm_kPa),
      ha: h_a_actual + cpAvg * (Ti - aCWT_C)
    };
  });

  return {
    Tmin, Tmax,
    satCurve,
    chevPts,
    hADesign: saturationEnthalpy(dWB_C, Patm_kPa),
    hAActual: h_a_actual,
    aCWT: aCWT_C, aHWT: aHWT_C, aWB: aWB_C, dWB: dWB_C
  };
}

function runPredictCWT(p) {
  const { dWB_C, dCWT_C, dHWT_C, aWB_C, Patm_kPa = 101.325 } = p;

  if (!isFinite(dWB_C) || !isFinite(dCWT_C) || !isFinite(dHWT_C) || !isFinite(aWB_C))
    return { error: 'Enter Design WBT, CWT, HWT and Actual WBT first.' };

  const app_d = dCWT_C - dWB_C, rng_d = dHWT_C - dCWT_C;
  if (app_d <= 0) return { error: 'Design approach ≤ 0: CWT must be > WBT.' };
  if (rng_d <= 0) return { error: 'Design range ≤ 0: HWT must be > CWT.' };

  const kappa = computeKappa(dCWT_C, dHWT_C, dWB_C, Patm_kPa);
  if (kappa === null) return { error: '⚠ κ solver did not converge. Check input ranges.' };

  const pred_C = calcPredictedCWT(dCWT_C, dWB_C, aWB_C, kappa);
  const dWBT_C = aWB_C - dWB_C;
  const dCWT_delta = pred_C - dCWT_C;

  return {
    pred_C: parseFloat(pred_C.toFixed(2)),
    kappa: parseFloat(kappa.toFixed(3)),
    dWBT_C: parseFloat(dWBT_C.toFixed(2)),
    dCWT_delta: parseFloat(dCWT_delta.toFixed(2)),
    Patm_kPa: parseFloat(Patm_kPa.toFixed(2))
  };
}
