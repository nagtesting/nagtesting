// ============================================================
// Vercel Serverless API — Psychrometric Engine
// All thermodynamic calculations run server-side.
// Client sends raw inputs; server returns computed state.
// ============================================================

// ── ASHRAE 2009 Wexler-Hyland saturation pressure ──────────
function satPressure(T_C) {
  const T = T_C + 273.15;
  if (T_C >= 0) {
    const C8 = -5.8002206e3, C9 = 1.3914993, C10 = -4.8640239e-2,
          C11 = 4.1764768e-5, C12 = -1.4452093e-8, C13 = 6.5459673;
    return Math.exp(C8/T + C9 + C10*T + C11*T*T + C12*T*T*T + C13*Math.log(T)) / 1000;
  } else {
    const C1 = -5.6745359e3, C2 = 6.3925247, C3 = -9.677843e-3,
          C4 = 6.2215701e-7, C5 = 2.0747825e-9, C6 = -9.484024e-13, C7 = 4.1635019;
    return Math.exp(C1/T + C2 + C3*T + C4*T*T + C5*T*T*T + C6*T*T*T*T + C7*Math.log(T)) / 1000;
  }
}

// ── ISA atmosphere pressure from altitude ──────────────────
function altitudePressure(z_m) {
  return 101.325 * Math.pow(1 - 0.0065 * z_m / 288.15, 5.255);
}

// ── ASHRAE humidity ratio ──────────────────────────────────
function humidityRatio(pv_kPa, p_kPa) {
  return 0.621945 * pv_kPa / (p_kPa - pv_kPa);
}

// ── Moist air enthalpy (kJ/kg dry air) ─────────────────────
function enthalpy(T_C, W) {
  return 1.006 * T_C + W * (2501 + 1.86 * T_C);
}

// ── Specific volume (m³/kg dry air) ────────────────────────
function specVolume(T_C, W, p_kPa) {
  return 0.287058 * (T_C + 273.15) * (1 + 1.6078 * W) / p_kPa;
}

// ── Dew point — ARM (Alduchov & Eskridge 1996) ─────────────
function dewPoint(rh_fraction, T_C) {
  const a = 17.625, b = 243.04;
  const alpha = Math.log(Math.max(rh_fraction, 1e-6)) + a * T_C / (b + T_C);
  return b * alpha / (a - alpha);
}

// ── Wet bulb — Stull (2011) + ASHRAE thermodynamic Newton ──
function wetBulbApprox(T_C, rh_fraction, p_kPa) {
  const rh100 = rh_fraction * 100;
  let wb = T_C * Math.atan(0.151977 * Math.pow(rh100 + 8.313659, 0.5))
         + Math.atan(T_C + rh100)
         - Math.atan(rh100 - 1.676331)
         + 0.00391838 * Math.pow(rh100, 1.5) * Math.atan(0.023101 * rh100)
         - 4.686035;
  wb = Math.min(wb, T_C);
  const W_target = humidityRatio(satPressure(T_C) * rh_fraction, p_kPa);
  for (let i = 0; i < 50; i++) {
    const Ws_wb = humidityRatio(satPressure(wb), p_kPa);
    const W_calc = ((2501 - 2.381 * wb) * Ws_wb - 1.006 * (T_C - wb))
                 / (2501 + 1.805 * T_C - 4.186 * wb);
    const err = W_calc - W_target;
    if (Math.abs(err) < 1e-9) break;
    const h = 1e-4;
    const Ws_wb_h = humidityRatio(satPressure(wb + h), p_kPa);
    const W_calc_h = ((2501 - 2.381 * (wb + h)) * Ws_wb_h - 1.006 * (T_C - (wb + h)))
                   / (2501 + 1.805 * T_C - 4.186 * (wb + h));
    const dFdwb = (W_calc_h - W_calc) / h;
    wb -= Math.abs(dFdwb) > 1e-12 ? err / dFdwb : err * 60;
    wb = Math.min(wb, T_C);
  }
  return wb;
}

// ── Full state point from T, RH%, altitude ─────────────────
function calcState(T_C, rh_pct, z_m, p_override) {
  const p = p_override > 0 ? p_override : altitudePressure(z_m);
  const ps = satPressure(T_C);
  const rh = rh_pct / 100;
  const pv = ps * rh;
  const W = humidityRatio(pv, p);
  const h = enthalpy(T_C, W);
  const v = specVolume(T_C, W, p);
  const rho = (1 + W) / v;
  return { T: T_C, p, rh, W, h, v, rho, pv, ps };
}

// ── HVAC process ────────────────────────────────────────────
function calcProcess(T1, rh1, T2, rh2, Q_m3h, z_m) {
  const S1 = calcState(T1, rh1, z_m);
  const S2 = calcState(T2, rh2, z_m);
  const Q_kgs = Q_m3h / 3600 * S1.rho / (1 + S1.W);
  const dh = S2.h - S1.h;
  const dW = S2.W - S1.W;
  const Q_total = Q_kgs * dh;
  const Q_sensible = Q_kgs * 1.006 * (T2 - T1);
  const T_mean = (T1 + T2) / 2;
  const h_fg = 2501 - 2.381 * T_mean;
  const Q_latent = Q_kgs * h_fg * dW;
  const m_water = Q_kgs * Math.abs(dW) * 3600;
  const SHR = Math.abs(Q_total) > 0.001 ? Math.abs(Q_sensible) / Math.abs(Q_total) : 1.0;
  const procType = dh < 0
    ? (dW < -0.0001 ? 'Cooling + Dehumidification' : 'Sensible Cooling Only')
    : (dW > 0.0001 ? 'Heating + Humidification' : 'Sensible Heating Only');
  return { S1, S2, Q_kgs, dh, dW, Q_total, Q_sensible, Q_latent, m_water, SHR, procType };
}

// ── Duct / fan calculator ───────────────────────────────────
function calcDuct(T_C, rh_pct, z_m, shape, dims, Q_m3h, L, rough_mm) {
  const S = calcState(T_C, rh_pct, z_m);
  let A_m2, Dh_m, perim_m;
  if (shape === 'round') {
    const D = dims.diameter / 1000;
    A_m2 = Math.PI * D * D / 4;
    Dh_m = D;
    perim_m = Math.PI * D;
  } else {
    const W = dims.width / 1000, H = dims.height / 1000;
    A_m2 = W * H;
    Dh_m = 4 * A_m2 / (2 * (W + H));
    perim_m = 2 * (W + H);
  }
  const Q_m3s = Q_m3h / 3600;
  const rough_m = rough_mm / 1000;
  const vel_ms = Q_m3s / A_m2;
  // Sutherland's law — temperature-dependent viscosity
  const T_K = T_C + 273.15;
  const mu = 1.716e-5 * Math.pow(T_K / 273.15, 1.5) * (273.15 + 110.4) / (T_K + 110.4);
  const Re = S.rho * vel_ms * Dh_m / mu;
  let f, regimeNote = '';
  if (Re > 4000) {
    f = 0.25 / Math.pow(Math.log10(rough_m / (3.7 * Dh_m) + 5.74 / Math.pow(Re, 0.9)), 2);
  } else if (Re > 2300) {
    const f_lam = 64 / 2300;
    const f_turb = 0.25 / Math.pow(Math.log10(rough_m / (3.7 * Dh_m) + 5.74 / Math.pow(4000, 0.9)), 2);
    f = f_lam + (f_turb - f_lam) * (Re - 2300) / (4000 - 2300);
    regimeNote = 'Transition regime (Re 2300–4000) — friction factor interpolated; result uncertain ±20%';
  } else {
    f = Re > 0 ? 64 / Re : 0.02;
  }
  const dP_Pa = f * (L / Dh_m) * 0.5 * S.rho * vel_ms * vel_ms;
  const dP_mmWg = dP_Pa / 9.80665;
  const Pstatic_Pa = 0.5 * S.rho * vel_ms * vel_ms;
  const fanPower_kW = (dP_Pa * Q_m3s) / (1000 * 0.7);
  return { S, A_m2, Dh_m, perim_m, vel_ms, Re, f, dP_Pa, dP_mmWg, Pstatic_Pa, fanPower_kW, regimeNote };
}

// ── RH curves for chart (server generates coordinate data) ──
function calcChartData(p_kPa) {
  const Tmin = -10, Tmax = 50, Wmax = 0.030;
  const step = 0.5;
  const points = t => {
    const arr = [];
    for (let tt = Tmin; tt <= Tmax; tt += step) {
      arr.push({ t: tt, W: humidityRatio(satPressure(tt), p_kPa) });
    }
    return arr;
  };
  const satCurve = points();
  const rhCurves = [20, 30, 40, 50, 60, 70, 80].map(rh => {
    const pts = [];
    for (let t = Tmin; t <= Tmax; t += step) {
      const W = humidityRatio(satPressure(t) * rh / 100, p_kPa);
      if (W >= 0 && W <= Wmax) pts.push({ t, W });
    }
    return { rh, pts };
  });
  const enthalpyLines = [];
  for (let h_line = 10; h_line <= 110; h_line += 10) {
    const pts = [];
    for (let t = Tmin; t <= Tmax; t += step) {
      const W = (h_line - 1.006 * t) / (2501 + 1.86 * t);
      if (W >= 0 && W <= Wmax) pts.push({ t, W });
    }
    enthalpyLines.push({ h: h_line, pts });
  }
  return { satCurve, rhCurves, enthalpyLines };
}

// ════════════════════════════════════════════════════════════
// VERCEL HANDLER
// ════════════════════════════════════════════════════════════
export default function handler(req, res) {
  // CORS headers (adjust origin in production)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { action, payload } = req.body;

    // ── STATE POINT ─────────────────────────────────────────
    if (action === 'statePoint') {
      const { T, mode, z, p_override, rh, wb, dp, W_in } = payload;

      if (T < -60 || T > 80) {
        return res.status(400).json({ error: 'Temperature out of valid range (−60°C to 80°C)' });
      }
      const p = p_override > 0 ? p_override : altitudePressure(z);
      const ps = satPressure(T);
      let pv, rh_val, W_val;

      if (mode === 'rh') {
        rh_val = rh / 100;
        pv = ps * rh_val;
      } else if (mode === 'wb') {
        if (wb > T) return res.status(400).json({ error: 'Wet bulb must be ≤ dry bulb temperature' });
        const psw = satPressure(wb);
        pv = psw - 0.000662 * p * (T - wb);
        rh_val = pv / ps;
      } else if (mode === 'dp') {
        if (dp >= T) return res.status(400).json({ error: 'Dew point must be < dry bulb temperature' });
        pv = satPressure(dp);
        rh_val = pv / ps;
      } else if (mode === 'w') {
        W_val = W_in;
        pv = W_val * p / (0.621945 + W_val);
        rh_val = pv / ps;
      }

      rh_val = Math.max(0, Math.min(1, rh_val));
      if (!W_val) W_val = humidityRatio(pv, p);
      const h = enthalpy(T, W_val);
      const v = specVolume(T, W_val, p);
      const rho = (1 + W_val) / v;
      const dp_C = dewPoint(rh_val, T);
      const wb_C = wetBulbApprox(T, rh_val, p);

      return res.status(200).json({
        T, p, ps, pv, rh: rh_val, W: W_val, h, v, rho, dp: dp_C, wb: wb_C
      });
    }

    // ── HVAC PROCESS ────────────────────────────────────────
    if (action === 'process') {
      const { T1, rh1, T2, rh2, Q_m3h, z } = payload;
      return res.status(200).json(calcProcess(T1, rh1, T2, rh2, Q_m3h, z));
    }

    // ── DUCT ────────────────────────────────────────────────
    if (action === 'duct') {
      const { T, rh, z, shape, dims, Q_m3h, L, rough_mm } = payload;
      return res.status(200).json(calcDuct(T, rh, z, shape, dims, Q_m3h, L, rough_mm));
    }

    // ── CHART DATA ──────────────────────────────────────────
    if (action === 'chartData') {
      const { p } = payload;
      return res.status(200).json(calcChartData(p || 101.325));
    }

    // ── ALTITUDE → PRESSURE ─────────────────────────────────
    if (action === 'altPressure') {
      return res.status(200).json({ p: altitudePressure(payload.z) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[psychrometric]', err);
    return res.status(500).json({ error: 'Internal calculation error', detail: err.message });
  }
}
