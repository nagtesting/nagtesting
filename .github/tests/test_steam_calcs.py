import sys
import math
import importlib.util

# ── Load steam-calcs.py as a module ──────────────────────────────────────
spec = importlib.util.spec_from_file_location(
    'steam_calcs', 'api/steam-calcs.py'
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
inst = object.__new__(mod.handler)

# ── Test runner ───────────────────────────────────────────────────────────
passed = 0
failed = 0
errors = []

def check(name, condition, detail=''):
    global passed, failed
    if condition:
        print(f'  ✅  {name}')
        passed += 1
    else:
        print(f'  ❌  {name}  {detail}')
        failed += 1
        errors.append(name)

def close(a, b, tol=0.5, name=''):
    ok = math.isfinite(a) and math.isfinite(b) and abs(a - b) <= tol
    if not ok:
        print(f'       got {a}, expected ~{b} (tol {tol})')
    return ok


# ════════════════════════════════════════════════════════════════════════
# SECTION A — STEAM PROPERTIES
# Reference values from IAPWS-IF97 verification tables
# ════════════════════════════════════════════════════════════════════════
print('\nSECTION A — Steam Properties')

# A-1: Saturated liquid at 1 bar — NIST reference: T=99.63°C, h=417.44 kJ/kg
r = inst._section_a({'type':'sat-liq','specBy':'P','P_bar':1.0,'sys':'SI'})
d = r['data']
check('A-1  sat-liq 1 bar: Tsat=99.63°C',  close(d['T'],   99.63, 0.1))
check('A-1  sat-liq 1 bar: hf=417.44',      close(d['h'],  417.44, 0.5))
check('A-1  sat-liq 1 bar: sf=1.3026',      close(d['s'],   1.3026, 0.002))
check('A-1  sat-liq 1 bar: vf=0.001043',    close(d['v'],   0.001043, 0.00001))

# A-2: SUB-ATMOSPHERIC — the original bug (0.133 bar → Tsat should be ~51.5°C not 99.63°C)
r = inst._section_a({'type':'sat-liq','specBy':'P','P_bar':0.133,'sys':'SI'})
d = r['data']
check('A-2  sub-atm 0.133 bar: Tsat~51.5°C (bug fix)', close(d['T'], 51.5, 0.5))

# A-3: Superheated steam at 10 bar, 300°C — NIST: h=3051.2, s=7.1229
r = inst._section_a({'type':'superheat','P_bar':10.0,'T_C':300.0,'sys':'SI'})
d = r['data']
check('A-3  superheat 10bar 300C: h=3051.2',  close(d['h'], 3051.2, 1.0))
check('A-3  superheat 10bar 300C: s=7.1229',  close(d['s'],   7.1229, 0.01))
check('A-3  superheat 10bar 300C: dT_sh=120°C', close(d['dT_sh'], 120.1, 0.3))

# A-4: Wet steam split transport fields present (was missing before)
r = inst._section_a({'type':'wet','specBy':'P','P_bar':5.0,'x':0.85,'sys':'SI'})
d = r['data']
check('A-4  wet steam: mu_f present',  d.get('mu_f')  is not None)
check('A-4  wet steam: mu_g present',  d.get('mu_g')  is not None)
check('A-4  wet steam: lam_f present', d.get('lam_f') is not None)
check('A-4  wet steam: Cp_f present',  d.get('Cp_f')  is not None)
check('A-4  wet steam: x=0.85',        close(d['x'], 0.85, 0.001))

# A-5: Saturated vapor at 100 bar — NIST: T=311.06°C, hg=2724.5
r = inst._section_a({'type':'sat-vap','specBy':'P','P_bar':100.0,'sys':'SI'})
d = r['data']
check('A-5  sat-vap 100bar: T=311.06°C', close(d['T'], 311.06, 0.1))
check('A-5  sat-vap 100bar: hg=2724.5',  close(d['h'], 2724.5,  1.0))

# A-6: Imperial conversion — 1 bar = 14.504 psi, 99.63°C = 211.33°F
r = inst._section_a({'type':'sat-liq','specBy':'P','P_bar':1.0,'sys':'IMP'})
d = r['data']
check('A-6  imperial: P in psi~14.504', close(d['P'], 14.504, 0.05))
check('A-6  imperial: T in °F~211.3',   close(d['T'], 211.33,  0.2))

# A-7: Compressed liquid — 1 bar, 80°C (below Tsat=99.63)
r = inst._section_a({'type':'compressed','P_bar':1.0,'T_C':80.0,'sys':'SI'})
d = r['data']
check('A-7  compressed liquid: phase correct', d['data']['phaseCls'] == 'compressed'
      if 'data' in d else d.get('phaseCls') == 'compressed')

# A-8: Error handling — T above Tsat for compressed
r = inst._section_a({'type':'compressed','P_bar':1.0,'T_C':110.0,'sys':'SI'})
check('A-8  compressed error on T>Tsat', 'error' in r)


# ════════════════════════════════════════════════════════════════════════
# SECTION B — STEAM QUENCH
# ════════════════════════════════════════════════════════════════════════
print('\nSECTION B — Steam Quench')

BASE = {'P_s':10.0,'T1':350.0,'Tw':30.0,'Pw':12.0,'T2':200.0,
        'm_in':10000.0,'sh_min':10,'f_min':30,'f_max':110,'cv_in':0}

r = inst._section_b(BASE)
check('B-1  no error on valid inputs', 'error' not in r)

# Mass balance: m_out = m_in + m_w
check('B-2  mass balance',
      close(r['m_out'], r['m_in'] + r['m_w'], 0.1))

# Energy balance: Q_rem ≈ Q_abs (adiabatic)
check('B-3  energy balance Q_rem~Q_abs',
      close(r['Q_rem'], r['Q_abs'], 1.0))

# All 30+ HTML-required fields present
required = [
    'Ps','T1','T2','Tw','Pw','m_in','Ts',
    'h1','h2','hw','v1','v2','s1','s2',
    'ratio','m_w','m_out','qPct','Q_rem','Q_abs',
    'sh_out','shSt','mw_min','mw_max','mo_min','mo_max',
    'fMin','fMax','shMin_C','hf_Ps','hg_Ps',
    'sensT','sensW','warns','ts','unc_h1','unc_h2','unc_hw',
    'outletQuality',
]
missing = [f for f in required if f not in r]
check('B-4  all HTML fields present', not missing, str(missing))

# shSt is object with c/lbl/bb (not just a string)
shSt = r.get('shSt', {})
check('B-5  shSt is object {c,lbl,bb}',
      isinstance(shSt, dict) and 'c' in shSt and 'lbl' in shSt and 'bb' in shSt)

# Ps is MPa (10 bar steam → 1.0 MPa)
check('B-6  Ps returned in MPa',  close(r['Ps'], 1.0, 0.01))

# Pw is MPa (12 bar water → 1.2 MPa)
check('B-7  Pw returned in MPa',  close(r['Pw'], 1.2, 0.01))

# ts is a non-empty string
check('B-8  ts timestamp present', isinstance(r.get('ts'), str) and len(r['ts']) > 5)

# hf_Ps and hg_Ps are finite numbers
check('B-9  hf_Ps finite',  math.isfinite(r.get('hf_Ps', float('nan'))))
check('B-10 hg_Ps finite',  math.isfinite(r.get('hg_Ps', float('nan'))))

# sensT has base row (d=0)
base_rows = [row for row in r.get('sensT', []) if row.get('base')]
check('B-11 sensT has base row (d=0)', len(base_rows) == 1)

# Valve Cv with cv_in
r2 = inst._section_b({**BASE, 'cv_in': 50.0})
cv = r2.get('cv_res', {})
check('B-12 cv_res returned when cv_in>0', cv is not None)
check('B-13 cv_res.rat present', 'rat' in cv)
check('B-14 cv_res.sigma present', 'sigma' in cv)
check('B-15 cv_res.FL = 0.90', close(cv.get('FL', 0), 0.90, 0.01))

# Error on T2 > T1
r3 = inst._section_b({**BASE, 'T2': 400.0})
check('B-16 error when T2>T1', 'error' in r3)

# Error on T1 not superheated
r4 = inst._section_b({**BASE, 'T1': 150.0})  # Tsat@10bar = 179.9°C
check('B-17 error when T1 not superheated', 'error' in r4)


# ════════════════════════════════════════════════════════════════════════
# SECTION C — STEAM TURBINE
# ════════════════════════════════════════════════════════════════════════
print('\nSECTION C — Steam Turbine')

# C-1: inletProps — superheated at 40 bar, 400°C → NIST h≈3213.6
r = inst._section_c({'action':'inletProps','P_bar':40.0,'T_C':400.0})
check('C-1  inletProps 40bar 400C: h~3213', close(r['h'], 3213.6, 3.0))
check('C-1  inletProps: T_sat returned',   'T_sat' in r)
check('C-1  inletProps: phase=superheated', r.get('phase') == 'superheated')

# C-2: inletProps at saturation (no T_C)
r = inst._section_c({'action':'inletProps','P_bar':10.0,'T_C':None})
check('C-2  inletProps no T_C: phase=sat', r.get('phase') == 'sat')

# C-3: exhaustProps
r = inst._section_c({'action':'exhaustProps','P_bar':1.0,'s1_SI':7.1229})
check('C-3  exhaustProps: h2s finite', math.isfinite(r.get('h2s', float('nan'))))
check('C-3  exhaustProps: hfg present', 'hfg' in r)

# C-4: backpressure
r = inst._section_c({'action':'calculate','turbineType':'backpressure',
    'flow_kgh':50000,'h1_SI':3213.6,'h2s_SI':2801.4,'s1_SI':6.771,
    'p1_bar':40.0,'p2_bar':4.0,'eff':0.85,'effm':0.98,'effg':0.97})
check('C-4  backpressure: pw>0',    r.get('pw', 0) > 0)
check('C-4  backpressure: pe<pw',   r.get('pe', 0) < r.get('pw', 1))
check('C-4  backpressure: eta>0',   r.get('eta', 0) > 0)

# C-5: condensing returns heatRate, condP_bar, satCond_T
r = inst._section_c({'action':'calculate','turbineType':'condensing',
    'flow_kgh':50000,'h1_SI':3213.6,'h2s_SI':2350.0,'s1_SI':6.771,
    'p1_bar':40.0,'p2_bar':0.1,'eff':0.85,'effm':0.98,'effg':0.97,
    'cwIn_C':25.0,'cwOut_C':35.0,'hf_SI':191.8,'condP_bar':0.1})
check('C-5  condensing: heatRate present',  'heatRate'  in r)
check('C-5  condensing: condP_bar present', 'condP_bar' in r)
check('C-5  condensing: satCond_T present', 'satCond_T' in r)
check('C-5  condensing: Q_cond>0',          r.get('Q_cond', 0) > 0)

# C-6: extraction — JS field names (extFrac, he_SI)
r = inst._section_c({'action':'calculate','turbineType':'extraction',
    'flow_kgh':50000,'h1_SI':3213.6,'h2s_SI':2450.0,'s1_SI':6.771,
    'p1_bar':40.0,'p2_bar':1.0,'eff':0.85,'effm':0.98,'effg':0.97,
    'extFrac':'0.3','he_SI':'2900.0'})
check('C-6  extraction: Q_proc present',  'Q_proc'  in r)
check('C-6  extraction: w_HP present',    'w_HP'    in r)
check('C-6  extraction: w_LP present',    'w_LP'    in r)
check('C-6  extraction: he_SI echoed',    'he_SI'   in r)
check('C-6  extraction: h2_exh present',  'h2_exh'  in r)
check('C-6  extraction: extFrac echoed',  'extFrac' in r)
check('C-6  extraction: mExt present',    'mExt'    in r)
check('C-6  extraction: mExh present',    'mExh'    in r)

# C-7: error handling
r = inst._section_c({'action':'calculate','turbineType':'backpressure',
    'flow_kgh':50000,'h1_SI':2800.0,'h2s_SI':3000.0,  # h1 < h2s — invalid
    's1_SI':6.771,'p1_bar':10.0,'p2_bar':1.0,'eff':0.85,'effm':0.98,'effg':0.97})
check('C-7  error when h1<h2s', 'error' in r)


# ════════════════════════════════════════════════════════════════════════
# SECTION D — RANKINE CYCLE
# ════════════════════════════════════════════════════════════════════════
print('\nSECTION D — Rankine Cycle')

# D-1: tsat action — critical for autofill (was 404 before fix)
r = inst._section_d({'type':'tsat','params':{'P_MPa':1.0}})
check('D-1  tsat 1MPa: Tsat~179.9°C', close(r.get('tsat', 0), 179.9, 0.2))

r2 = inst._section_d({'type':'tsat','params':{'P_MPa':0.01}})
check('D-2  tsat 0.01MPa: Tsat~45.8°C', close(r2.get('tsat', 0), 45.8, 0.3))

# D-3: body format {type, params} — critical (was broken before fix)
r = inst._section_d({'type':'basic','params':{
    'T3':400,'Ph':4.0,'T1':45,'Pc':0.01,
    'etaT':0.85,'etaP':0.80,'etaG':0.95,'etaB':0.88,
    'mdot':10.0,'hhv':43.0}})
check('D-3  basic: ok=True',          r.get('ok') == True)
check('D-3  basic: etaTh in range',   0.1 < r.get('etaTh', 0) < 0.50)
check('D-3  basic: etaCarnot > etaTh', r.get('etaCarnot', 0) > r.get('etaTh', 1))
check('D-3  basic: WkW > 0',          r.get('WkW', 0) > 0)
check('D-3  basic: s1 is dict',       isinstance(r.get('s1'), dict))
check('D-3  basic: s3 is dict',       isinstance(r.get('s3'), dict))
check('D-3  basic: TsatBoiler present', 'TsatBoiler' in r)

# D-4: superheat
r = inst._section_d({'type':'superheat','params':{
    'Tsh':450,'Ph':6.0,'Tc':35,'Pc':0.006,
    'etaT':0.87,'etaP':0.82,'mdot':8.0}})
check('D-4  superheat: ok=True',    r.get('ok') == True)
check('D-4  superheat: dsh present', 'dsh' in r)
check('D-4  superheat: TsatB present', 'TsatB' in r)
check('D-4  superheat: s1 dict',    isinstance(r.get('s1'), dict))

# D-5: reheat — optP2 must be present (HTML reads r.optP2)
r = inst._section_d({'type':'reheat','params':{
    'T1':500,'P1':10.0,'Trh':480,'P2':2.0,'Pc':0.01,
    'etaHPT':0.87,'etaLPT':0.87,'etaP':0.80,'mdot':10.0,'Tc':None}})
check('D-5  reheat: ok=True',       r.get('ok') == True)
check('D-5  reheat: optP2 present', 'optP2' in r)
check('D-5  reheat: wHPT present',  'wHPT'  in r)
check('D-5  reheat: wLPT present',  'wLPT'  in r)
check('D-5  reheat: qBoiler present','qBoiler' in r)
check('D-5  reheat: Tsat1 present', 'Tsat1' in r)
check('D-5  reheat: s1 dict',       isinstance(r.get('s1'), dict))

# D-6: regen — h2 must be present (HTML reads r.h2)
r = inst._section_d({'type':'regen','params':{
    'Thi':500,'Phi':8.0,'Pbleed':1.5,'Pc':0.01,
    'etaT':0.87,'etaP':0.80,'mdot':10.0,'Tc':None}})
check('D-6  regen: ok=True',         r.get('ok') == True)
check('D-6  regen: h2 present',      'h2' in r)
check('D-6  regen: h_bl present',    'h_bl' in r)
check('D-6  regen: y in 0-0.5',      0 <= r.get('y', -1) <= 0.5)
check('D-6  regen: TsatBleed present','TsatBleed' in r)
check('D-6  regen: TsatIn present',  'TsatIn'    in r)
check('D-6  regen: s1 dict',         isinstance(r.get('s1'), dict))

# D-7: carnot — wrongEta must be present (HTML shows incorrect °C calc)
r = inst._section_d({'type':'carnot','params':{'TH':500,'TC':30,'QH':1000,'actual':None}})
check('D-7  carnot: etaC correct',    close(r.get('etaC', 0), 1-303.15/773.15, 0.001))
check('D-7  carnot: wrongEta present','wrongEta' in r)
check('D-7  carnot: COPhp present',   'COPhp'    in r)
check('D-7  carnot: COPref present',  'COPref'   in r)
check('D-7  carnot: TH_K = 773.15',   close(r.get('TH_K', 0), 773.15, 0.01))

# D-8: 2nd law violation caught
r = inst._section_d({'type':'carnot','params':{'TH':500,'TC':30,'QH':1000,'actual':99}})
check('D-8  carnot: error on eta>Carnot limit', 'error' in r)


# ════════════════════════════════════════════════════════════════════════
# SUMMARY
# ════════════════════════════════════════════════════════════════════════
print(f'\n{"="*60}')
print(f'  RESULTS: {passed} passed,  {failed} failed')
print(f'{"="*60}')
if errors:
    print('\nFailed tests:')
    for e in errors:
        print(f'  ❌  {e}')
    print()
    sys.exit(1)
else:
    print('\n  All tests passed ✅')
    sys.exit(0)
