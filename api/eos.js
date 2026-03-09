// ================================================================
// api/eos.js  —  Vercel Serverless Function
// 🔐 ALL CALCULATION LOGIC RUNS ON SERVER — NEVER EXPOSED TO BROWSER
// Place this file in your GitHub repo at: /api/eos.js
// ================================================================

export default function handler(req, res) {
  // Allow CORS for your domain only
  const origin = req.headers.origin || '';
  const allowed = origin.endsWith('.vercel.app') || origin === 'https://multicalci.com';
  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : 'https://multicalci.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { eos, T_K, P_Pa, Tc_K, Pc_Pa, omega, M, n } = req.body;

    if (!eos)          return res.status(400).json({ error: 'Missing EOS type' });
    if (!isFinite(T_K)  || T_K  <= 0) return res.status(400).json({ error: 'Temperature must be positive and finite.' });
    if (!isFinite(P_Pa) || P_Pa <= 0) return res.status(400).json({ error: 'Pressure must be positive and finite.' });
    if (!isFinite(Tc_K) || Tc_K <= 0) return res.status(400).json({ error: 'Critical temperature Tc must be positive.' });
    if (!isFinite(Pc_Pa)|| Pc_Pa<= 0) return res.status(400).json({ error: 'Critical pressure Pc must be positive.' });
    if (!isFinite(M)    || M    <  1)  return res.status(400).json({ error: 'Molar mass must be ≥ 1 g/mol.' });
    if (!isFinite(n)    || n    <= 0)  return res.status(400).json({ error: 'Number of moles must be positive.' });
    if (T_K < 10) return res.status(400).json({ error: `Temperature ${T_K.toFixed(2)} K is below 10 K. EOS calculations are not reliable at near-absolute-zero temperatures.` });

    const roots = runEOS(eos, T_K, P_Pa, Tc_K, Pc_Pa, omega);
    if (!roots.length) return res.status(400).json({ error: 'No real solution found — conditions may be below absolute minimum volume for this EOS. Try a lower pressure or higher temperature.' });

    const primary = roots.reduce((a, b) => a.Z > b.Z ? a : b);
    const Z       = primary.Z;

    if (!isFinite(Z) || Z <= 0) return res.status(400).json({ error: `EOS produced an invalid Z-factor (${Z}). Conditions may be in an unphysical region.` });
    if (Z > 20)                 return res.status(400).json({ error: `Z = ${Z.toFixed(3)} — unusually high. Check inputs.` });

    const phi      = primary.phi;
    const Vm_SI    = primary.Vm;
    const rho_mass = (1 / Vm_SI) * (M / 1000);
    const f_Pa     = phi * P_Pa;
    const Tr       = T_K / Tc_K;
    const Pr       = P_Pa / Pc_Pa;

    const warnings = buildWarnings(eos, T_K, P_Pa, Tc_K, Pc_Pa, omega, Z, Tr, Pr, roots);

    return res.status(200).json({
      success: true,
      data: {
        Z, phi, Vm_SI, rho_mass, f_Pa, Tr, Pr,
        roots: roots.map(r => ({ Z: r.Z, Vm: r.Vm, phi: r.phi, label: r.label })),
        rootCount: roots.length,
        eosParams: { A: primary.A, B: primary.B, a: primary.a, b: primary.b,
                     m: primary.m, kappa: primary.kappa, alpha: primary.alpha },
        warnings
      }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server calculation error: ' + err.message });
  }
}

// ================================================================
// 🔐 CORE CALCULATION ENGINE — HIDDEN ON SERVER
// ================================================================

const R = 8.314462; // J/(mol·K)

function solveCubic(c2, c1, c0) {
  const shift = -c2 / 3;
  const p = c1 - c2 * c2 / 3;
  const q = 2 * c2 * c2 * c2 / 27 - c1 * c2 / 3 + c0;
  const D = q * q / 4 + p * p * p / 27;
  let roots = [];

  if (D > 1e-10) {
    const sqrtD = Math.sqrt(D);
    const u = Math.cbrt(-q / 2 + sqrtD);
    const v = Math.cbrt(-q / 2 - sqrtD);
    roots = [u + v + shift];
  } else if (D < -1e-10) {
    const r       = Math.sqrt(-p * p * p / 27);
    const cosArg  = Math.max(-1, Math.min(1, -q / (2 * r)));
    const theta   = Math.acos(cosArg);
    const m       = 2 * Math.cbrt(r);
    roots = [
      m * Math.cos(theta / 3) + shift,
      m * Math.cos((theta + 2 * Math.PI) / 3) + shift,
      m * Math.cos((theta + 4 * Math.PI) / 3) + shift,
    ];
  } else {
    const u = Math.cbrt(-q / 2);
    roots = [2 * u + shift, -u + shift];
  }

  return roots.filter(z => z > 1e-6 && isFinite(z)).sort((a, b) => a - b);
}

function solveIdeal(T_K, P_Pa) {
  const Vm = R * T_K / P_Pa;
  return [{ Z: 1, Vm, phi: 1, label: 'Z = 1 (Ideal)' }];
}

function solveVdW(T_K, P_Pa, Tc_K, Pc_Pa) {
  const a  = 27 * R * R * Tc_K * Tc_K / (64 * Pc_Pa);
  const b  = R * Tc_K / (8 * Pc_Pa);
  const c2 = -(b + R * T_K / P_Pa);
  const c1 = a / P_Pa;
  const c0 = -a * b / P_Pa;
  const Vms = solveCubic(c2, c1, c0);
  return Vms.map((Vm, i) => {
    const Z     = P_Pa * Vm / (R * T_K);
    const lnPhi = b / (Vm - b) - Math.log(Math.max(1e-300, P_Pa * (Vm - b) / (R * T_K))) - 2 * a / (R * T_K * Vm);
    return { Z, Vm, phi: Math.exp(lnPhi), label: ['Vapour Z', 'Middle Z', 'Liquid Z'][i] || 'Z', a, b };
  });
}

function solveSRK(T_K, P_Pa, Tc_K, Pc_Pa, omega) {
  const a0          = 0.42748 * R * R * Tc_K * Tc_K / Pc_Pa;
  const b           = 0.08664 * R * Tc_K / Pc_Pa;
  const m           = 0.480 + 1.574 * omega - 0.176 * omega * omega;
  const Tr          = T_K / Tc_K;
  const sqrtTr      = Math.sqrt(Math.max(0, Tr));
  const alpha_base  = 1 + m * (1 - sqrtTr);
  const alpha       = Math.max(1e-6, alpha_base * alpha_base);
  const a           = a0 * alpha;
  const A           = a * P_Pa / (R * R * T_K * T_K);
  const B           = b * P_Pa / (R * T_K);
  const c2 = -1;
  const c1 = A - B - B * B;
  const c0 = -A * B;
  const Zs = solveCubic(c2, c1, c0);
  return Zs.map((Z, i) => {
    const Vm    = Z * R * T_K / P_Pa;
    const lnPhi = (Z - 1) - Math.log(Math.max(1e-300, Z - B)) - (A / B) * Math.log(Math.max(1e-300, 1 + B / Z));
    return { Z, Vm, phi: Math.exp(lnPhi), label: ['Vapour Z', 'Middle Z', 'Liquid Z'][i] || 'Z', A, B, a, b, m, alpha };
  });
}

function solvePR(T_K, P_Pa, Tc_K, Pc_Pa, omega) {
  const a0          = 0.45724 * R * R * Tc_K * Tc_K / Pc_Pa;
  const b           = 0.07780 * R * Tc_K / Pc_Pa;
  const kappa       = 0.37464 + 1.54226 * omega - 0.26992 * omega * omega;
  const Tr          = T_K / Tc_K;
  const alpha_base  = 1 + kappa * (1 - Math.sqrt(Math.max(0, Tr)));
  const alpha       = Math.max(1e-6, alpha_base * alpha_base);
  const a           = a0 * alpha;
  const A           = a * P_Pa / (R * R * T_K * T_K);
  const B           = b * P_Pa / (R * T_K);
  const c2 = -(1 - B);
  const c1 = A - 3 * B * B - 2 * B;
  const c0 = -(A * B - B * B - B * B * B);
  const Zs = solveCubic(c2, c1, c0);
  return Zs.map((Z, i) => {
    const Vm     = Z * R * T_K / P_Pa;
    const sq2    = Math.SQRT2;
    const denom1 = Math.max(1e-300, Z + (1 + sq2) * B);
    const denom2 = Math.max(1e-300, Z + (1 - sq2) * B);
    const lnPhi  = (Z - 1) - Math.log(Math.max(1e-300, Z - B)) - A / (2 * sq2 * B) * Math.log(denom1 / denom2);
    return { Z, Vm, phi: Math.exp(lnPhi), label: ['Vapour Z', 'Middle Z', 'Liquid Z'][i] || 'Z', A, B, a, b, kappa, alpha };
  });
}

function runEOS(eos, T_K, P_Pa, Tc_K, Pc_Pa, omega) {
  switch (eos) {
    case 'ideal': return solveIdeal(T_K, P_Pa);
    case 'vdw':   return solveVdW(T_K, P_Pa, Tc_K, Pc_Pa);
    case 'srk':   return solveSRK(T_K, P_Pa, Tc_K, Pc_Pa, omega);
    case 'pr':    return solvePR(T_K, P_Pa, Tc_K, Pc_Pa, omega);
    default: return [];
  }
}

function buildWarnings(eos, T_K, P_Pa, Tc_K, Pc_Pa, omega, Z, Tr, Pr, roots) {
  const warnings = [];
  const POLAR_GASES_SET  = new Set(['H2O','MeOH','EtOH','iPrOH','nPrOH','nBuOH','iBuOH','nPenOH','EG','HF','FormAcid','AcAcid','PropAcid','NH3','HCN']);
  const QUANTUM_GASES    = new Set(['H2','He']);
  const ASSOC_GASES      = new Set(['AcAcid','FormAcid','PropAcid','HF']);

  if (Tr < 0.5)            warnings.push({ type: 'subcritical', msg: `Deep subcritical region (Tr = ${Tr.toFixed(3)}): Operating well below Tc. Liquid-phase properties may be unreliable.` });
  if (Math.abs(Tr-1)<0.05 && Math.abs(Pr-1)<0.05)
                           warnings.push({ type: 'critical', msg: `Near-critical region (Tr ≈ ${Tr.toFixed(3)}, Pr ≈ ${Pr.toFixed(3)}): EOS accuracy is reduced very close to the critical point.` });
  if (Pr > 10)             warnings.push({ type: 'highP', msg: `Very high reduced pressure (Pr = ${Pr.toFixed(2)}): Cubic EOS accuracy degrades at Pr > 10.` });
  else if (Pr > 5)         warnings.push({ type: 'highP', msg: `High reduced pressure (Pr = ${Pr.toFixed(2)}): Validate results at Pr > 5.` });
  if (eos === 'ideal' && Pr > 0.1) warnings.push({ type: 'ideal', msg: `Ideal gas law: only accurate at Pr < 0.1. At Pr = ${Pr.toFixed(3)}, switch to PR or SRK.` });
  if (eos === 'vdw')       warnings.push({ type: 'vdw', msg: 'van der Waals EOS is historical/qualitative (1873). Use PR or SRK for engineering work.' });
  if (roots.length === 3)  warnings.push({ type: 'twophase', msg: `Three real roots found (Tr=${Tr.toFixed(3)}, Pr=${Pr.toFixed(3)}) — possible two-phase region. Largest Z = vapour, smallest Z = liquid.` });
  if (Z > 2.0 && eos !== 'ideal') warnings.push({ type: 'highZ', msg: `Z = ${Z.toFixed(4)} is above typical range. Verify conditions.` });
  if (Z < 0.2 && Z > 0 && eos !== 'ideal') warnings.push({ type: 'lowZ', msg: `Very low Z-factor (Z = ${Z.toFixed(4)}) — may indicate liquid-like conditions.` });

  return warnings;
}
