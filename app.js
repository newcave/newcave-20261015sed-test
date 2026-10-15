/*
 * 침전지 유동 진단 · 수시 CFD 모의 — 개념 데모
 * - 정수장 침전지 3차원 CFD를 AI 서로게이트로 대체해 경계조건 변경 시 즉시 재계산하는 흐름을 보여주는 화면 예시입니다.
 * - 화면의 유동장 · 수치는 모두 해석적 근사식으로 만든 가상값이며, 실제 CFD 또는 학습된 모델 결과가 아닙니다.
 * - 의존성: vendor/preact.min.umd.js, vendor/htm.umd.js (빌드 과정 없음)
 */
(function () {
  'use strict';

  var h = preact.h;
  var renderApp = preact.render;
  var Component = preact.Component;
  var html = htm.bind(h);

  var ACCENT = '#45B8D0';
  var MONO = "font-family: 'IBM Plex Mono', ui-monospace, monospace";

  /* ---------------- 설정 · 시나리오 ---------------- */

  var PRESETS = [
    { key: 'live', label: '현재 실측', bc: { Q: 1850, H: 4.2, Tin: 14.8, Tw: 15.6, turb: 12, wind: 2.1, dir: '북서', air: 12.4, solar: 310, rain: 0 } },
    { key: 'storm', label: '집중호우 예보', bc: { Q: 2350, H: 4.4, Tin: 13.6, Tw: 15.4, turb: 85, wind: 6.8, dir: '남동', air: 14.0, solar: 40, rain: 40 } },
    { key: 'winter', label: '동절기 저수온', bc: { Q: 1500, H: 4.0, Tin: 3.5, Tw: 5.2, turb: 6, wind: 4.2, dir: '북서', air: -6.0, solar: 180, rain: 0 } },
    { key: 'surge', label: '유입량 +30%', bc: { Q: 2450, H: 4.5, Tin: 15.0, Tw: 15.6, turb: 18, wind: 1.5, dir: '서', air: 13.0, solar: 320, rain: 0 } }
  ];

  // tmin~tmax: 서로게이트 학습범위(가정)
  var SPECS = [
    { key: 'Q', group: 'hyd', label: '유입량', unit: 'm³/h', min: 800, max: 3000, step: 50, tmin: 1200, tmax: 2600, dec: 0, src: '실측 · SCADA 유량계' },
    { key: 'H', group: 'hyd', label: '침전지 수위', unit: 'm', min: 3.0, max: 5.0, step: 0.05, tmin: 3.6, tmax: 4.8, dec: 2, src: '실측 · 수위계' },
    { key: 'Tin', group: 'hyd', label: '유입 수온', unit: '°C', min: 0, max: 30, step: 0.1, tmin: 5, tmax: 28, dec: 1, src: '실측 · 유입부 수온계' },
    { key: 'turb', group: 'hyd', label: '유입 탁도', unit: 'NTU', min: 0, max: 200, step: 1, tmin: 2, tmax: 120, dec: 0, src: '실측 · 원수 탁도계' },
    { key: 'wind', group: 'met', label: '풍속 (수면 전단)', unit: 'm/s', min: 0, max: 15, step: 0.1, tmin: 0, tmax: 10, dec: 1, src: '예보 · 기상청 단기예보' },
    { key: 'air', group: 'met', label: '기온 (수면 열교환)', unit: '°C', min: -15, max: 38, step: 0.1, tmin: -10, tmax: 35, dec: 1, src: '예보 · 기상청 단기예보' }
  ];

  var CMAPS = {
    vel: ['#26124B', '#2E3F8F', '#1F7E8C', '#2BAE7E', '#9AD44A', '#F5E43A'],
    turb: ['#120C24', '#4A1A6B', '#8E2A6A', '#D1495B', '#F28F3B', '#FBE29C'],
    temp: ['#2C5F9E', '#5E98CB', '#A8CBE0', '#E9E2D0', '#E7A273', '#C2533A']
  };

  /* ---------------- 유틸 ---------------- */

  function fmt(v, dec) {
    return Number(v).toLocaleString('ko-KR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function cl(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function presetLabel(key) {
    var p = PRESETS.find(function (x) { return x.key === key; });
    return p ? p.label : '사용자 정의';
  }
  function copy(o) { return Object.assign({}, o); }
  function hex(hx) { return [parseInt(hx.slice(1, 3), 16), parseInt(hx.slice(3, 5), 16), parseInt(hx.slice(5, 7), 16)]; }
  function lerpColor(stops, t) {
    t = cl(t, 0, 1);
    var n = stops.length - 1, f = t * n, i = Math.min(n - 1, Math.floor(f)), u = f - i;
    var a = hex(stops[i]), b = hex(stops[i + 1]);
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * u) + ',' + Math.round(a[1] + (b[1] - a[1]) * u) + ',' + Math.round(a[2] + (b[2] - a[2]) * u) + ')';
  }
  function pill(fg, bg) {
    return 'display: inline-block; white-space: nowrap; font-size: 12px; font-weight: 500; line-height: 1.4; padding: 2px 8px; border-radius: 4px; color: ' + fg + '; background: ' + bg;
  }
  function stamp() {
    var n = new Date();
    var p = function (x) { return String(x).padStart(2, '0'); };
    return { md: p(n.getMonth() + 1) + p(n.getDate()), mdDash: p(n.getMonth() + 1) + '-' + p(n.getDate()), hm: p(n.getHours()) + ':' + p(n.getMinutes()) };
  }

  /* ---------------- 근사 물리(가상) ---------------- */

  // 침전지 제원(가정): L 80 m × W 20 m, 표면적 1,600 m²
  function derive(bc) {
    var A = 1600, W = 20;
    var sor = bc.Q / A * 1000 / 60;                 // 표면부하율 mm/min
    var hrt = A * bc.H / bc.Q;                      // 체류시간 h
    var dT = bc.Tw - bc.Tin;                        // +: 유입수가 차가움(무거움)
    var dc = cl(cl(dT / 4, 0, 1) * 0.8 + cl(bc.turb / 150, 0, 1) * 0.5, 0, 1); // 저층 밀도류 강도
    var sc = cl(-dT / 4, 0, 1);                     // 표층류 강도
    var w = cl(bc.wind / 10, 0, 1);
    var sci = cl(0.12 + 0.3 * dc + 0.2 * sc + 0.25 * w + 0.3 * cl((sor - 18) / 15, 0, 1), 0, 1); // 단락류 지수
    var visc = 1 + cl((15 - bc.Tin) / 15, 0, 1) * 0.8;
    var eff = bc.turb * (0.025 + 0.045 * sci) * (1 + cl((sor - 18) / 20, 0, 1)) * visc; // 침전수 탁도
    var ys = (bc.dir === '남동' || bc.dir === '남' || bc.dir === '동') ? 0.18 : 0.82;
    var umean = bc.Q / 3600 / (W * bc.H) * 100;     // 평균 유속 cm/s
    return { sor: sor, hrt: hrt, dT: dT, dc: dc, sc: sc, w: w, sci: sci, eff: eff, ys: ys, umean: umean, removal: bc.turb > 0 ? 1 - eff / bc.turb : 0 };
  }

  function velPlan(x, y, bc, d) {
    var q = bc.Q / 1850, jet = 0;
    [0.125, 0.375, 0.625, 0.875].forEach(function (yk) { jet += Math.exp(-Math.pow((y - yk) / 0.07, 2)); });
    jet *= 2.4 * q * Math.exp(-x / 0.16);
    var side = d.sci * 1.8 * Math.exp(-Math.pow((y - d.ys) / 0.16, 2)) * (0.3 + 0.7 * x);
    var weir = 1.0 * q * Math.pow(Math.max(0, (x - 0.9) / 0.1), 2);
    var damp = Math.max(0.1, 1 - 0.6 * Math.exp(-y / 0.04) - 0.6 * Math.exp(-(1 - y) / 0.04));
    return (d.umean + jet + side + weir) * damp;
  }
  function velSec(x, z, bc, d) {
    var q = bc.Q / 1850;
    var jet = 2.4 * q * Math.exp(-x / 0.16) * Math.exp(-Math.pow((z - 0.45) / 0.2, 2));
    var bot = d.dc * 2.2 * Math.exp(-(1 - z) / 0.16) * Math.exp(-x / 0.75) * (1 - Math.exp(-(1 - z) / 0.03));
    var top = d.sc * 1.8 * Math.exp(-z / 0.15) * Math.exp(-x / 0.75) + d.w * 0.9 * Math.exp(-z / 0.08);
    var weir = 1.4 * q * Math.pow(Math.max(0, (x - 0.86) / 0.14), 2) * Math.exp(-z / 0.25);
    return d.umean * (0.6 + 0.6 * Math.sin(Math.PI * Math.min(z, 0.98))) + jet + bot + top + weir;
  }
  function turbPlan(x, y, bc, d) {
    var lam = 0.2 + 0.25 * d.sci;
    var path = 1 + d.sci * 1.4 * Math.exp(-Math.pow((y - d.ys) / 0.16, 2));
    return d.eff + (bc.turb - d.eff) * Math.exp(-x / (lam * path));
  }
  function turbSec(x, z, bc, d) {
    var lam = 0.2 + 0.25 * d.sci + 0.15 * d.dc;
    var c = d.eff + (bc.turb - d.eff) * Math.exp(-x / lam) * (0.55 + 0.9 * z);
    if (z > 0.85) c += bc.turb * 0.7 * (1 - 0.6 * x) * ((z - 0.85) / 0.15);
    return c;
  }
  function tempPlan(x, y, bc) {
    return bc.Tw + (bc.Tin - bc.Tw) * Math.exp(-x / 0.28) * 0.7 + (bc.air - bc.Tw) * 0.03 * (0.5 + 0.5 * x);
  }
  function tempSec(x, z, bc) {
    var dT = bc.Tin - bc.Tw;
    var wgt = dT < 0 ? Math.exp(-(1 - z) / 0.3) : Math.exp(-z / 0.3);
    return bc.Tw + dT * (0.35 * Math.exp(-x / 0.15) + 0.65 * Math.exp(-x / 0.45) * wgt) + (bc.air - bc.Tw) * 0.06 * Math.exp(-z / 0.07);
  }

  function quiverPath(view, bc, d) {
    var NXq = 16, NYq = 4, Wv = 480, Hv = view === 'plan' ? 120 : 100;
    var r = function (v) { return v.toFixed(1); };
    var p = '';
    for (var j = 0; j < NYq; j++) {
      for (var i = 0; i < NXq; i++) {
        var x = (i + 0.5) / NXq, y = (j + 0.5) / NYq, v, dy;
        if (view === 'plan') {
          v = velPlan(x, y, bc, d);
          dy = (d.ys - y) * d.sci * 1.2 * x + (y - 0.5) * 0.25 * Math.exp(-x / 0.15);
        } else {
          v = velSec(x, y, bc, d);
          dy = d.dc * 0.7 * Math.exp(-x / 0.3) * (1 - y) - d.sc * 0.7 * Math.exp(-x / 0.3) * y - (x > 0.8 ? 1.4 * (x - 0.8) / 0.2 * (1 - 0.5 * y) : 0);
        }
        var m = Math.hypot(1, dy), ux = 1 / m, uy = dy / m;
        var len = 8 + 14 * Math.min(v / 3, 1);
        var cx = x * Wv, cy = y * Hv;
        var x0 = cx - ux * len / 2, y0 = cy - uy * len / 2, x1 = cx + ux * len / 2, y1 = cy + uy * len / 2;
        var c = Math.cos(0.5), sn = Math.sin(0.5), hl = 4;
        var hx1 = x1 - hl * (ux * c - uy * sn), hy1 = y1 - hl * (uy * c + ux * sn);
        var hx2 = x1 - hl * (ux * c + uy * sn), hy2 = y1 - hl * (uy * c - ux * sn);
        p += 'M' + r(x0) + ' ' + r(y0) + 'L' + r(x1) + ' ' + r(y1) + 'M' + r(hx1) + ' ' + r(hy1) + 'L' + r(x1) + ' ' + r(y1) + 'L' + r(hx2) + ' ' + r(hy2);
      }
    }
    return p;
  }

  function oor(bc) {
    return SPECS.filter(function (sp) { var v = bc[sp.key]; return v < sp.tmin || v > sp.tmax; })
      .map(function (sp) { return sp.label.replace(/\s*\(.*\)$/, '') + ' ' + fmt(bc[sp.key], sp.dec) + ' ' + sp.unit; });
  }
  function bcSummary(bc) {
    return 'Q ' + fmt(bc.Q, 0) + ' · Tin ' + fmt(bc.Tin, 1) + ' °C · ' + fmt(bc.turb, 0) + ' NTU · ' + fmt(bc.wind, 1) + ' m/s';
  }
  function statusOf(eff) {
    if (eff >= 2) return { t: '경보', fg: '#FFB4A6', bg: 'rgba(239, 106, 85, 0.16)', bd: '#7A3328' };
    if (eff >= 1) return { t: '주의', fg: '#F5C76B', bg: 'rgba(232, 169, 58, 0.14)', bd: '#6B5221' };
    return { t: '정상', fg: '#8EDDB0', bg: 'rgba(92, 192, 138, 0.14)', bd: '#2C5A41' };
  }

  function initialJobs() {
    var dLive = derive(PRESETS[0].bc), dStorm = derive(PRESETS[1].bc);
    return [
      { id: 'SIM-1015-0142', at: '10-15 14:10', trig: '상시 (10분 주기)', bc: bcSummary(PRESETS[0].bc), engine: '서로게이트', status: '완료 · 1.8 s', kind: 'ok', result: fmt(dLive.eff, 2) + ' NTU' },
      { id: 'SIM-1015-0131', at: '10-15 12:35', trig: '기상특보 (호우 예비)', bc: '시나리오 · 강수 40 mm/6 h', engine: '서로게이트', status: '완료 · 2.1 s', kind: 'ok', result: fmt(dStorm.eff, 2) + ' NTU' },
      { id: 'CFD-1014-07', at: '10-14 18:20', trig: '학습범위 밖 (수온 3.5 °C)', bc: '시나리오 · 동절기 저수온', engine: '정밀 CFD (용역사)', status: '계산 중 63 %', kind: 'run', result: '—' },
      { id: 'CFD-1012-05', at: '10-12 09:00', trig: '실측 보정 · 검증', bc: '수온 · 탁도 프로파일 3점', engine: '정밀 CFD (용역사)', status: '완료 · 학습셋 반영', kind: 'done', result: '보고서' }
    ];
  }

  /* ---------------- 앱 ---------------- */

  class App extends Component {
    constructor(props) {
      super(props);
      var bc = copy(PRESETS[0].bc);
      this.state = {
        mode: 'adhoc', preset: 'live', bc: bc, manual: {},
        run: { bc: copy(bc), id: 'SIM-1015-0143', at: '14:20', dur: '1.8 s', preset: 'live' },
        layer: 'vel', showVectors: true, running: false,
        seq: 144, cfdSeq: 8, toast: '', jobs: initialJobs()
      };
    }

    componentWillUnmount() { if (this._t) clearTimeout(this._t); }

    setBc(key, val) {
      if (isNaN(val)) return;
      var bc = copy(this.state.bc); bc[key] = val;
      var manual = copy(this.state.manual); manual[key] = true;
      this.setState({ bc: bc, manual: manual, preset: 'custom', toast: '' });
    }
    pickPreset(key) {
      var p = PRESETS.find(function (x) { return x.key === key; });
      this.setState({ preset: key, bc: copy(p.bc), manual: {}, toast: '' });
    }
    setMode(m) {
      if (m === 'auto') this.setState({ mode: 'auto', preset: 'live', bc: copy(PRESETS[0].bc), manual: {}, toast: '' });
      else this.setState({ mode: 'adhoc' });
    }
    onRun() {
      if (this.state.running) return;
      this.setState({ running: true, toast: '' });
      var self = this;
      this._t = setTimeout(function () {
        var s = self.state, t = stamp();
        var id = 'SIM-' + t.md + '-0' + s.seq;
        var bc = copy(s.bc), d = derive(bc);
        var trig = s.mode === 'auto' ? '상시 (즉시 실행)' : '수시 · ' + presetLabel(s.preset);
        var job = { id: id, at: t.mdDash + ' ' + t.hm, trig: trig, bc: bcSummary(bc), engine: '서로게이트', status: '완료 · 1.6 s', kind: 'ok', result: fmt(d.eff, 2) + ' NTU' };
        self.setState({ running: false, seq: s.seq + 1, run: { bc: bc, id: id, at: t.hm, dur: '1.6 s', preset: s.preset }, jobs: [job].concat(s.jobs).slice(0, 8) });
      }, 1400);
    }
    onCfd() {
      var s = this.state, t = stamp(), o = oor(s.bc);
      var id = 'CFD-' + t.md + '-' + String(s.cfdSeq).padStart(2, '0');
      var job = { id: id, at: t.mdDash + ' ' + t.hm, trig: o.length ? '학습범위 밖 (' + o[0] + ')' : '수동 정밀 검증', bc: bcSummary(s.bc), engine: '정밀 CFD (용역사)', status: '대기 · 계산 큐', kind: 'wait', result: '—' };
      this.setState({ cfdSeq: s.cfdSeq + 1, jobs: [job].concat(s.jobs).slice(0, 8), toast: id + ' 등록: 용역사 CFD 계산 큐로 전달되며, 완료되면 학습 데이터 후보로 편입됩니다.' });
    }

    buildFields(run, layer) {
      var key = run.id + '|' + layer;
      if (this._fkey === key) return this._f;
      var bc = run.bc, d = derive(bc);
      var NX = 48, NY = 12, NZ = 10;
      var fP = layer === 'vel' ? velPlan : layer === 'turb' ? turbPlan : tempPlan;
      var fS = layer === 'vel' ? velSec : layer === 'turb' ? turbSec : tempSec;
      var pv = [], sv = [], i, j, k;
      for (j = 0; j < NY; j++) for (i = 0; i < NX; i++) pv.push(fP((i + 0.5) / NX, (j + 0.5) / NY, bc, d));
      for (k = 0; k < NZ; k++) for (i = 0; i < NX; i++) sv.push(fS((i + 0.5) / NX, (k + 0.5) / NZ, bc, d));
      var lo, hi, title, dec;
      if (layer === 'vel') { lo = 0; hi = 3; title = '유속 크기 (cm/s)'; dec = 1; }
      else if (layer === 'turb') { lo = 0; hi = Math.max(1, bc.turb); title = '탁도 (NTU)'; dec = bc.turb < 20 ? 1 : 0; }
      else {
        var all = pv.concat(sv);
        lo = Math.min.apply(null, all) - 0.2; hi = Math.max.apply(null, all) + 0.2; title = '수온 (°C)'; dec = 1;
      }
      var stops = CMAPS[layer];
      var col = function (v) { return lerpColor(stops, (v - lo) / (hi - lo)); };
      var pts = [
        { name: 'P1', where: '유입부', x: 0.15, y: 0.5, oT: 0.2, oC: 0.08 },
        { name: 'P2', where: '중간부', x: 0.5, y: 0.5, oT: -0.1, oC: -0.06 },
        { name: 'P3', where: '위어 전단', x: 0.93, y: 0.5, oT: 0.1, oC: 0.12 }
      ];
      var isLive = run.preset === 'live';
      var muted = 'color: #93A1AE';
      var cards = pts.map(function (p) {
        if (layer === 'vel') return { name: p.name, where: p.where, meas: '미계측', pred: fmt(velPlan(p.x, p.y, bc, d), 2) + ' cm/s', diff: '향후 유속계', diffStyle: muted };
        var pred = layer === 'temp' ? tempPlan(p.x, p.y, bc, d) : turbPlan(p.x, p.y, bc, d);
        var u = layer === 'temp' ? ' °C' : ' NTU', dd = layer === 'temp' ? 1 : 2;
        if (!isLive) return { name: p.name, where: p.where, meas: '—', pred: fmt(pred, dd) + u, diff: '시나리오', diffStyle: muted };
        var meas = layer === 'temp' ? pred + p.oT : pred * (1 + p.oC);
        var diff = layer === 'temp' ? meas - pred : (meas - pred) / Math.max(pred, 0.01) * 100;
        var ok = layer === 'temp' ? Math.abs(diff) <= 0.5 : Math.abs(diff) <= 15;
        return { name: p.name, where: p.where, meas: fmt(meas, dd) + u, pred: fmt(pred, dd) + u, diff: 'Δ ' + (diff >= 0 ? '+' : '') + fmt(diff, 1) + (layer === 'temp' ? ' °C' : ' %'), diffStyle: ok ? 'color: #8EDDB0' : 'color: #F5C76B' };
      });
      this._f = {
        plan: pv.map(col), sec: sv.map(col),
        qPlan: quiverPath('plan', bc, d), qSec: quiverPath('sec', bc, d),
        cbarTitle: title,
        cbarGrad: 'linear-gradient(90deg, ' + stops.join(', ') + ')',
        lo: fmt(lo, dec), mid: fmt((lo + hi) / 2, dec), hi: (layer === 'turb' ? '≥ ' : '') + fmt(hi, dec),
        sensors: pts.map(function (p) { return { name: p.name, left: (p.x * 100) + '%', top: (p.y * 100) + '%' }; }),
        sensorCards: cards,
        sensorNote: layer === 'vel' ? '유속은 현재 실측 없음 · 수온 · 탁도로 검증' : (isLive ? '최근 10분 평균 · 위치 P1–P3' : '시나리오 모의는 실측 비교 대상 아님')
      };
      this._fkey = key;
      return this._f;
    }

    chart(d) {
      var meas = [], fc = [], i, k;
      for (i = 0; i <= 12; i++) meas.push(0.46 + 0.1 * Math.sin(i * 0.85) + 0.05 * Math.cos(i * 2.1) + 0.02 * i / 12);
      var last = meas[12];
      for (k = 0; k <= 6; k++) fc.push(last + (d.eff - last) * (1 - Math.exp(-k / 1.6)) / (1 - Math.exp(-6 / 1.6)));
      var unc = function (kk) { return ((0.06 + 0.2 * d.sci) * Math.max(d.eff, 0.4)) * (kk / 6) + 0.01 * kk; };
      var raw = Math.max(2.4, d.eff * 1.15 + unc(6), Math.max.apply(null, meas));
      var steps = [2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 40, 60];
      var ymax = steps[steps.length - 1];
      for (i = 0; i < steps.length; i++) { if (steps[i] >= raw) { ymax = steps[i]; break; } }
      var X = function (hr) { return ((hr + 12) / 18 * 720).toFixed(1); };
      var Y = function (v) { return (160 - Math.max(0, v) / ymax * 160).toFixed(1); };
      var up = [], dn = [];
      for (k = 0; k <= 6; k++) { up.push(X(k) + ',' + Y(fc[k] + unc(k))); dn.unshift(X(k) + ',' + Y(fc[k] - unc(k))); }
      return {
        meas: meas.map(function (v, ii) { return X(ii - 12) + ',' + Y(v); }).join(' '),
        fc: fc.map(function (v, kk) { return X(kk) + ',' + Y(v); }).join(' '),
        band: up.concat(dn).join(' '),
        thrY: Y(2.0),
        yMaxText: fmt(ymax, 1), yMidText: fmt(ymax / 2, 1),
        endText: '+6 h 전망 ' + fmt(fc[6], 2) + ' NTU',
        aria: '침전수 탁도 실측 12시간과 모의조건 적용 6시간 전망. 6시간 후 ' + fmt(fc[6], 2) + ' NTU, 관리목표 2.0 NTU'
      };
    }

    recs(d, oorRun) {
      var out = [];
      if (oorRun.length) out.push({ lvl: '검증', text: '학습범위 밖 입력(' + oorRun.join(', ') + ') — 결과는 참고용. 정밀 CFD 검증 요청을 권장합니다.' });
      if (d.eff >= 2) out.push({ lvl: '경보', text: '예측 침전수 탁도 ' + fmt(d.eff, 2) + ' NTU로 관리목표 초과. 응집제 주입률 재검토, 타 계열로 유량 분산을 검토하세요.' });
      else if (d.eff >= 1) out.push({ lvl: '주의', text: '예측 침전수 탁도 ' + fmt(d.eff, 2) + ' NTU로 목표에 근접. 여과지 부하 증가에 대비하세요.' });
      if (d.sci >= 0.45) out.push({ lvl: '주의', text: '단락류 지수 ' + fmt(d.sci, 2) + ' — 평면도 ' + (d.ys > 0.5 ? '하단' : '상단') + ' 측벽을 따라 유속이 집중됩니다. 위어 수평과 월류 편중을 점검하세요.' });
      if (d.dc >= 0.35) out.push({ lvl: '주의', text: '유입수가 지내수보다 무거워 저층 밀도류가 우세합니다. 바닥 유속 증가에 따른 슬러지 재부상을 감시하고 인발 주기 단축을 검토하세요.' });
      if (d.sc >= 0.35) out.push({ lvl: '주의', text: '유입수가 가벼워 표층류가 형성됩니다. 위어 쪽 조기 도달 가능성을 확인하세요.' });
      if (!out.length) out.push({ lvl: '정상', text: '침전 성능 양호. 현 운전 유지, 다음 상시 모의는 10분 후 실행됩니다.' });
      var map = {
        '경보': ['#FFB4A6', 'rgba(239, 106, 85, 0.16)'],
        '주의': ['#F5C76B', 'rgba(232, 169, 58, 0.14)'],
        '검증': ['#9FD8E6', 'rgba(69, 184, 208, 0.14)'],
        '정상': ['#8EDDB0', 'rgba(92, 192, 138, 0.14)']
      };
      return out.map(function (r) { return { lvl: r.lvl, text: r.text, badgeStyle: pill(map[r.lvl][0], map[r.lvl][1]) + '; flex: none' }; });
    }

    sliderRow(sp, s) {
      var self = this, v = s.bc[sp.key], span = sp.max - sp.min;
      var pct = function (a) { return (cl((a - sp.min) / span, 0, 1) * 100).toFixed(2) + '%'; };
      var inR = v >= sp.tmin && v <= sp.tmax;
      var src = sp.src;
      if (s.manual[sp.key]) src = '수동 입력';
      else if (s.preset !== 'live') src = '시나리오 · ' + presetLabel(s.preset);
      return {
        key: sp.key, id: 'bc-' + sp.key, label: sp.label, unit: sp.unit, min: sp.min, max: sp.max, step: sp.step, value: v,
        valueText: fmt(v, sp.dec),
        bandL: pct(sp.tmin), bandW: ((sp.tmax - sp.tmin) / span * 100).toFixed(2) + '%',
        pos: pct(v), tickColor: inR ? '#E4E9EE' : '#E8A93A',
        src: src,
        rangeText: (inR ? '' : '범위 밖 · ') + '학습 ' + fmt(sp.tmin, sp.dec) + '–' + fmt(sp.tmax, sp.dec),
        rangeStyle: inR ? 'color: #93A1AE' : 'color: #F5C76B',
        onInput: function (e) { self.setBc(sp.key, parseFloat(e.target.value)); }
      };
    }

    /* ---------------- 렌더링 ---------------- */

    renderSlider(r, disabled) {
      return html`
<div key=${r.key} style="display: flex; flex-direction: column; gap: 6px; padding: 10px 0; border-bottom: 1px solid #1F2830">
  <div style="display: flex; align-items: baseline; gap: 8px">
    <label for=${r.id} style="flex: 1; color: #C9D2DA; font-size: 13px">${r.label}</label>
    <span style=${MONO + '; font-size: 15px; color: #E4E9EE'}>${r.valueText}</span>
    <span style="font-size: 12px; color: #93A1AE; min-width: 40px">${r.unit}</span>
  </div>
  <input id=${r.id} type="range" min=${r.min} max=${r.max} step=${r.step} value=${r.value} onInput=${r.onInput} disabled=${disabled} style=${'width: 100%; margin: 0; accent-color: ' + ACCENT} />
  <div aria-hidden="true" style="position: relative; height: 4px; background: #222C35; border-radius: 2px">
    <div style=${'position: absolute; top: 0; bottom: 0; left: ' + r.bandL + '; width: ' + r.bandW + '; background: #2C5A66; border-radius: 2px'}></div>
    <div style=${'position: absolute; top: -3px; width: 2px; height: 10px; margin-left: -1px; left: ' + r.pos + '; background: ' + r.tickColor}></div>
  </div>
  <div style="display: flex; justify-content: space-between; gap: 8px; font-size: 12px"><span style="color: #93A1AE">${r.src}</span><span style=${r.rangeStyle}>${r.rangeText}</span></div>
</div>`;
    }

    renderField(cells, cols, rows, aspect, viewBox, qPath, showVectors, overlays, running) {
      return html`
<div style=${'position: relative; aspect-ratio: ' + aspect + '; border: 1px solid #3A4753; overflow: hidden; background: #0B0F13'}>
  <div style=${'position: absolute; inset: 0; display: grid; grid-template-columns: repeat(' + cols + ', minmax(0, 1fr)); grid-template-rows: repeat(' + rows + ', minmax(0, 1fr))'}>
    ${cells.map(function (c) { return html`<div style=${'background: ' + c}></div>`; })}
  </div>
  ${showVectors && html`
  <svg aria-hidden="true" viewBox=${viewBox} preserveAspectRatio="none" style="position: absolute; inset: 0; width: 100%; height: 100%">
    <path d=${qPath} fill="none" stroke="#0B0F13" stroke-opacity="0.55" stroke-width="2.6" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    <path d=${qPath} fill="none" stroke="#F4F7F9" stroke-width="1.1" stroke-linecap="round" vector-effect="non-scaling-stroke" />
  </svg>`}
  ${overlays}
  ${running && html`<div style=${'position: absolute; inset: 0; background: rgba(14, 19, 24, 0.74); display: flex; align-items: center; justify-content: center; font-size: 13px; color: #E4E9EE; ' + MONO}>서로게이트 추론 중 · 경계조건 → 3차원 장 재구성</div>`}
</div>`;
    }

    render() {
      var self = this, s = this.state;
      var isAuto = s.mode === 'auto', run = s.run;
      var d = derive(run.bc), f = this.buildFields(run, s.layer), st = statusOf(d.eff);
      var oorRun = oor(run.bc), oorNow = oor(s.bc);
      var dirty = JSON.stringify(s.bc) !== JSON.stringify(run.bc);
      var hydro = SPECS.filter(function (x) { return x.group === 'hyd'; }).map(function (sp) { return self.sliderRow(sp, s); });
      var met = SPECS.filter(function (x) { return x.group === 'met'; }).map(function (sp) { return self.sliderRow(sp, s); });
      var chart = this.chart(d), recs = this.recs(d, oorRun);

      var seg = function (on) {
        return 'min-height: 44px; padding: 0 14px; border-radius: 6px; font: inherit; font-size: 13px; cursor: pointer; border: 1px solid ' + (on ? ACCENT : 'transparent') + '; background: ' + (on ? '#1E3138' : 'transparent') + '; color: ' + (on ? '#E4E9EE' : '#B9C4CE');
      };
      var chip = function (on) {
        return 'min-height: 44px; padding: 0 14px; border-radius: 6px; font: inherit; font-size: 13px; cursor: pointer; border: 1px solid ' + (on ? ACCENT : '#33404B') + '; background: ' + (on ? '#1E3138' : '#1B242D') + '; color: ' + (on ? '#E4E9EE' : '#C9D2DA') + (isAuto ? '; opacity: 0.5; cursor: not-allowed' : '');
      };

      var tile = 'background: #151C23; border: 1px solid #26313C; border-radius: 8px; padding: 12px 14px';
      var dTs = (d.dT > 0 ? '−' : '+') + fmt(Math.abs(d.dT), 1);
      var kpis = [
        { label: '유입량', value: fmt(run.bc.Q, 0), unit: 'm³/h', sub: 'SCADA 1분 평균' },
        { label: '침전지 수위', value: fmt(run.bc.H, 2), unit: 'm', sub: '유효수심 기준' },
        { label: '수온 유입 / 지내', value: fmt(run.bc.Tin, 1) + ' / ' + fmt(run.bc.Tw, 1), unit: '°C', sub: '유입수 ' + dTs + ' °C' + (d.dc >= 0.35 ? ' · 밀도류' : '') },
        { label: '유입 탁도', value: fmt(run.bc.turb, 0), unit: 'NTU', sub: '원수 탁도계' },
        { label: '표면부하율', value: fmt(d.sor, 1), unit: 'mm/min', sub: '체류시간 ' + fmt(d.hrt, 1) + ' h' },
        { label: '단락류 지수', value: fmt(d.sci, 2), unit: '', sub: '0 플러그 흐름 · 1 완전 단락' },
        { label: '예측 침전수 탁도', value: fmt(d.eff, 2), unit: 'NTU', sub: '제거율 ' + fmt(d.removal * 100, 1) + ' % · 목표 2.0', status: true }
      ];

      var jobStyle = {
        ok: pill('#8EDDB0', 'rgba(92, 192, 138, 0.14)'),
        run: pill('#9FD8E6', 'rgba(69, 184, 208, 0.16)'),
        wait: pill('#C9D2DA', 'rgba(147, 161, 174, 0.16)'),
        done: pill('#B9C4CE', 'rgba(147, 161, 174, 0.10)')
      };
      var cfdOpen = s.jobs.filter(function (j) { return j.engine.indexOf('CFD') >= 0 && (j.kind === 'run' || j.kind === 'wait'); }).length;
      var runMeta = run.id + ' · ' + run.at + ' · 서로게이트 POD-RBF v0.3 · ' + run.dur + ' · ' + presetLabel(run.preset);
      var jobCols = 'display: grid; grid-template-columns: 130px 96px minmax(150px, 1.1fr) minmax(170px, 1.3fr) 120px 128px 92px; gap: 0 12px; padding: 8px 10px';
      var panel = 'min-width: 0; box-sizing: border-box; background: #151C23; border: 1px solid #26313C; border-radius: 8px; padding: 16px; display: flex; flex-direction: column';
      var h3 = 'margin: 0; font-size: 13px; font-weight: 600; color: #C9D2DA';
      var navLink = 'display: flex; align-items: center; min-height: 40px; padding: 0 10px; border-radius: 6px; color: #B9C4CE; text-decoration: none; font-size: 13px';

      var planOverlays = html`
        <div aria-hidden="true" style="position: absolute; left: 0; top: 0; bottom: 0; width: 5px; background: #D9E1E7"></div>
        <div aria-hidden="true" style="position: absolute; right: 2.5%; top: 6%; bottom: 6%; border-left: 2px dashed #F4F7F9"></div>
        ${f.sensors.map(function (p) {
          return html`<div key=${p.name} style=${'position: absolute; left: ' + p.left + '; top: ' + p.top + '; transform: translate(-6px, -50%); display: flex; align-items: center; gap: 4px'}>
            <span style="width: 8px; height: 8px; border-radius: 50%; border: 2px solid #FFFFFF; background: #0E1318"></span>
            <span style=${MONO + '; font-size: 11px; color: #FFFFFF; background: rgba(14, 19, 24, 0.8); padding: 0 4px; border-radius: 3px'}>${p.name}</span>
          </div>`;
        })}`;
      var secOverlays = html`
        <div aria-hidden="true" style="position: absolute; left: 0; top: 18%; bottom: 18%; width: 5px; background: #D9E1E7"></div>
        <div aria-hidden="true" style="position: absolute; right: 0; top: 0; width: 4%; height: 14%; border-left: 2px solid #F4F7F9; border-bottom: 2px solid #F4F7F9; box-sizing: border-box"></div>`;

      return html`
<div style="min-height: 100vh; background: #0E1318; color: #E4E9EE; font-family: 'IBM Plex Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif; font-size: 14px; line-height: 1.5">

<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px 20px; padding: 10px 24px; background: #11171D; border-bottom: 1px solid #26313C">
  <div style="display: flex; align-items: center; gap: 10px">
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke=${ACCENT} stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3c3.6 4.3 6 7.7 6 10.6a6 6 0 0 1-12 0C6 10.7 8.4 7.3 12 3z" /><path d="M9 14.5c.6 1.4 1.7 2.2 3.2 2.4" /></svg>
    <span style="font-weight: 600; font-size: 15px; letter-spacing: -0.01em">K-water 물종합진단 플랫폼</span>
  </div>
  <nav aria-label="현재 위치" style="display: flex; gap: 8px; font-size: 13px; color: #93A1AE"><span>정수 진단</span><span aria-hidden="true">/</span><span>침전지</span><span aria-hidden="true">/</span><span style="color: #E4E9EE">유동 진단</span></nav>
  <div style="flex: 1 1 auto"></div>
  <button type="button" style="display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 12px; border: 1px solid #33404B; border-radius: 6px; background: #151C23; color: #E4E9EE; font: inherit; font-size: 13px; cursor: pointer">○○정수장 · 1계열 · 침전지 #2<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#93A1AE" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg></button>
  <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #93A1AE"><span aria-hidden="true" style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #5CC08A"></span>실측 동기화 14:20 · SCADA · 기상청</div>
  <span style="font-size: 12px; color: #F5C76B; border: 1px solid #5A4520; padding: 2px 8px; border-radius: 4px">화면 예시 · 표시 수치는 가상값</span>
  <button type="button" aria-label="사용자 메뉴" style="min-height: 40px; padding: 0 12px; border: 1px solid #33404B; border-radius: 6px; background: transparent; color: #C9D2DA; font: inherit; font-size: 13px; cursor: pointer">물종합진단처</button>
</header>

<div style="display: flex; flex-wrap: wrap; align-items: flex-start">

<nav aria-label="진단 모듈" style="flex: 1 1 200px; box-sizing: border-box; padding: 20px 12px; display: flex; flex-direction: column; gap: 2px">
  <div style="font-size: 12px; color: #93A1AE; padding: 0 10px 6px">정수 공정 진단</div>
  <a href="#" style=${navLink}>원수 · 취수</a>
  <a href="#" style=${navLink}>혼화 · 응집</a>
  <a href="#" aria-current="page" style="display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 10px; border-radius: 6px; background: #1B2630; color: #E4E9EE; text-decoration: none; font-size: 13px; font-weight: 500"><span aria-hidden="true" style=${'width: 6px; height: 6px; border-radius: 50%; background: ' + ACCENT}></span>침전지 유동 진단</a>
  <a href="#" style=${navLink}>여과지</a>
  <a href="#" style=${navLink}>소독 · 정수지</a>
  <div style="font-size: 12px; color: #93A1AE; padding: 18px 10px 6px">데이터 · 모델</div>
  <a href="#" style=${navLink}>실측 센서 (수온 · 탁도)</a>
  <a href="#" style=${navLink}>CFD 데이터셋</a>
  <a href="#" style=${navLink}>서로게이트 모델 관리</a>
  <a href="#" style=${navLink}>모의 이력</a>
</nav>

<main style="flex: 999 1 560px; min-width: 0; box-sizing: border-box; padding: 20px 24px 40px; display: flex; flex-direction: column; gap: 16px">

<div style="display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px">
  <div style="flex: 1 1 420px; min-width: 0">
    <div style=${MONO + '; font-size: 12px; color: #93A1AE; letter-spacing: 0.06em'}>SED-BASIN 1-2 · 3D CFD SURROGATE</div>
    <h1 style="margin: 4px 0 0; font-size: 24px; font-weight: 600; letter-spacing: -0.01em">침전지 유동 진단 — 수시 CFD 모의</h1>
    <p style="margin: 6px 0 0; color: #93A1AE; max-width: 780px">경계조건(기상 · 유입량 · 수위)이 바뀌면 AI 서로게이트로 3차원 유동을 즉시 재계산합니다. 학습범위를 벗어난 조건은 정밀 CFD로 검증해 학습 데이터에 추가합니다.</p>
  </div>
  <div role="group" aria-label="운영 모드" style="display: flex; gap: 4px; background: #0F151B; border: 1px solid #26313C; border-radius: 8px; padding: 3px">
    ${[['auto', '상시 감시'], ['adhoc', '수시 모의']].map(function (m) {
      var on = s.mode === m[0];
      return html`<button key=${m[0]} type="button" aria-pressed=${on} onClick=${function () { self.setMode(m[0]); }} style=${seg(on)}>${m[1]}</button>`;
    })}
  </div>
</div>

<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px">
  ${kpis.map(function (k) {
    return html`
    <div key=${k.label} style=${k.status ? tile.replace('border: 1px solid #26313C', 'border: 1px solid ' + st.bd) : tile}>
      <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #93A1AE"><span style="flex: 1">${k.label}</span>${k.status && html`<span style=${pill(st.fg, st.bg)}>${st.t}</span>`}</div>
      <div style="display: flex; align-items: baseline; gap: 6px; margin-top: 4px"><span style=${MONO + '; font-size: 22px; font-weight: 500; letter-spacing: -0.02em'}>${k.value}</span><span style="font-size: 12px; color: #93A1AE">${k.unit}</span></div>
      <div style="font-size: 12px; color: #93A1AE; margin-top: 2px">${k.sub}</div>
    </div>`;
  })}
</div>

<div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start">

<section aria-labelledby="bc-title" style=${'flex: 1 1 340px; gap: 14px; ' + panel}>
  <div style="display: flex; align-items: center; gap: 8px">
    <h2 id="bc-title" style="margin: 0; font-size: 15px; font-weight: 600; flex: 1">경계조건 설정</h2>
    <span style=${dirty ? pill('#F5C76B', 'rgba(232, 169, 58, 0.14)') : pill('#8EDDB0', 'rgba(92, 192, 138, 0.14)')}>${dirty ? '변경됨 · 미실행' : '최신 모의 반영'}</span>
  </div>

  ${isAuto && html`<div style="font-size: 13px; color: #B9C4CE; background: #1B242D; border: 1px solid #26313C; border-radius: 6px; padding: 10px 12px">상시 감시 중: 실측 경계조건으로 10분마다 자동 모의합니다(다음 실행 14:30). 조건을 바꿔 보려면 수시 모의로 전환하세요.</div>`}

  <div>
    <div style="font-size: 12px; color: #93A1AE; margin-bottom: 6px">시나리오 불러오기</div>
    <div style="display: flex; flex-wrap: wrap; gap: 6px">
      ${PRESETS.map(function (p) {
        var on = s.preset === p.key;
        return html`<button key=${p.key} type="button" aria-pressed=${on} disabled=${isAuto} onClick=${function () { self.pickPreset(p.key); }} style=${chip(on)}>${p.label}</button>`;
      })}
    </div>
  </div>

  <div>
    <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 8px"><h3 style=${h3}>수리 · 수질 (유입 경계)</h3><span style="font-size: 12px; color: #93A1AE">CFD 유입/출구 조건</span></div>
    ${hydro.map(function (r) { return self.renderSlider(r, isAuto); })}
  </div>

  <div>
    <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 8px"><h3 style=${h3}>기상 (수면 경계)</h3><span style="font-size: 12px; color: #93A1AE">기상청 단기예보 14:00 발표</span></div>
    ${met.map(function (r) { return self.renderSlider(r, isAuto); })}
    <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px">
      <div style="background: #1B242D; border-radius: 6px; padding: 8px 10px"><div style="font-size: 12px; color: #93A1AE">풍향</div><div style=${MONO + '; font-size: 14px'}>${s.bc.dir}</div></div>
      <div style="background: #1B242D; border-radius: 6px; padding: 8px 10px"><div style="font-size: 12px; color: #93A1AE">일사량</div><div style=${MONO + '; font-size: 14px'}>${fmt(s.bc.solar, 0)} W/m²</div></div>
      <div style="background: #1B242D; border-radius: 6px; padding: 8px 10px"><div style="font-size: 12px; color: #93A1AE">강수 6 h</div><div style=${MONO + '; font-size: 14px'}>${fmt(s.bc.rain, 0)} mm</div></div>
    </div>
  </div>

  <div aria-hidden="true" style="display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: 12px; color: #93A1AE">
    <span style="display: flex; align-items: center; gap: 6px"><span style="width: 18px; height: 4px; border-radius: 2px; background: #2C5A66"></span>학습범위 (CFD 60회 + 추가 3회)</span>
    <span style="display: flex; align-items: center; gap: 6px"><span style="width: 2px; height: 10px; background: #E4E9EE"></span>입력값</span>
    <span style="display: flex; align-items: center; gap: 6px"><span style="width: 2px; height: 10px; background: #E8A93A"></span>범위 밖</span>
  </div>

  ${oorNow.length > 0 && html`<div role="note" style="font-size: 13px; color: #F5C76B; background: rgba(232, 169, 58, 0.10); border: 1px solid #6B5221; border-radius: 6px; padding: 10px 12px">학습범위 밖 입력: ${oorNow.join(', ')}. 서로게이트 결과는 참고용이며 정밀 CFD 검증을 권장합니다.</div>`}

  <div style="display: flex; flex-wrap: wrap; gap: 8px">
    <button type="button" onClick=${function () { self.onRun(); }} disabled=${s.running} style=${'flex: 1 1 170px; min-height: 46px; border: 0; border-radius: 6px; background: ' + ACCENT + '; color: #06171C; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer' + (s.running ? '; opacity: 0.7' : '')}>${s.running ? '모의 계산 중…' : (isAuto ? '지금 실행 (서로게이트)' : '모의 실행 (서로게이트)')}</button>
    <button type="button" onClick=${function () { self.onCfd(); }} style="flex: 1 1 150px; min-height: 46px; border: 1px solid #3A4753; border-radius: 6px; background: transparent; color: #E4E9EE; font: inherit; font-size: 14px; cursor: pointer">정밀 CFD 검증 요청</button>
  </div>
  <div style="font-size: 12px; color: #93A1AE">예상 소요: 서로게이트 약 2초 · 정밀 CFD [용역사 1회 계산시간 확인 필요]</div>
  ${s.toast && html`<div role="status" style="font-size: 13px; color: #9FD8E6; background: rgba(69, 184, 208, 0.10); border: 1px solid #24515B; border-radius: 6px; padding: 10px 12px">${s.toast}</div>`}
</section>

<section aria-labelledby="res-title" style=${'flex: 999 1 640px; gap: 14px; ' + panel}>
  <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px">
    <div style="flex: 1 1 260px; min-width: 0">
      <h2 id="res-title" style="margin: 0; font-size: 15px; font-weight: 600">3차원 유동 모의 결과</h2>
      <div style=${MONO + '; font-size: 12px; color: #93A1AE; margin-top: 2px'}>${runMeta}</div>
    </div>
    <label style="display: flex; align-items: center; gap: 6px; min-height: 44px; font-size: 13px; color: #B9C4CE; cursor: pointer"><input type="checkbox" checked=${s.showVectors} onChange=${function (e) { self.setState({ showVectors: e.target.checked }); }} style=${'accent-color: ' + ACCENT + '; width: 16px; height: 16px; margin: 0'} />유동 벡터</label>
    <div role="group" aria-label="표시 변수" style="display: flex; gap: 4px; background: #0F151B; border: 1px solid #26313C; border-radius: 8px; padding: 3px">
      ${[['vel', '유속 크기'], ['turb', '탁도'], ['temp', '수온']].map(function (l) {
        var on = s.layer === l[0];
        return html`<button key=${l[0]} type="button" aria-pressed=${on} onClick=${function () { self.setState({ layer: l[0] }); }} style=${seg(on)}>${l[1]}</button>`;
      })}
    </div>
  </div>

  ${dirty && html`<div role="status" style="font-size: 13px; color: #F5C76B; background: rgba(232, 169, 58, 0.10); border: 1px solid #6B5221; border-radius: 6px; padding: 8px 12px">경계조건이 바뀌었습니다. 아래 결과는 ${run.at} 모의 기준이며, 모의 실행을 누르면 새 조건으로 재계산합니다.</div>`}

  <div>
    <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px">
      <h3 style=${h3}>평면 분포 · 수심 1.0 m</h3>
      <span style=${MONO + '; font-size: 12px; color: #93A1AE'}>L 80 m × W 20 m · 표시 격자 48×12</span>
    </div>
    <div style="display: flex; justify-content: space-between; font-size: 12px; color: #93A1AE; margin-bottom: 4px"><span>유입 정류벽</span><span>월류 위어 (트로프)</span></div>
    ${this.renderField(f.plan, 48, 12, '4 / 1', '0 0 480 120', f.qPlan, s.showVectors, planOverlays, s.running)}
    <div aria-hidden="true" style=${'display: flex; justify-content: space-between; font-size: 11px; color: #93A1AE; margin-top: 4px; ' + MONO}><span>0</span><span>20</span><span>40</span><span>60</span><span>80 m</span></div>
  </div>

  <div>
    <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px">
      <h3 style=${h3}>종단면 · 중심선</h3>
      <span style=${MONO + '; font-size: 12px; color: #93A1AE'}>수심 ${fmt(run.bc.H, 2)} m · 연직 과장 약 ×4</span>
    </div>
    ${this.renderField(f.sec, 48, 10, '48 / 10', '0 0 480 100', f.qSec, s.showVectors, secOverlays, s.running)}
    <div aria-hidden="true" style="display: flex; justify-content: space-between; font-size: 12px; color: #93A1AE; margin-top: 4px"><span>유입 포트 (중층)</span><span>바닥 슬러지층 · 인발</span><span>위어 월류</span></div>
  </div>

  <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px">
    <span style="font-size: 12px; color: #C9D2DA; min-width: 120px">${f.cbarTitle}</span>
    <div style="flex: 1 1 240px; min-width: 0">
      <div style=${'height: 10px; border-radius: 2px; background: ' + f.cbarGrad}></div>
      <div style=${'display: flex; justify-content: space-between; font-size: 11px; color: #93A1AE; margin-top: 3px; ' + MONO}><span>${f.lo}</span><span>${f.mid}</span><span>${f.hi}</span></div>
    </div>
  </div>

  <div>
    <div style="display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-bottom: 6px"><h3 style=${h3}>실측 센서 대비 (물종합진단처 계측)</h3><span style="font-size: 12px; color: #93A1AE">${f.sensorNote}</span></div>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px">
      ${f.sensorCards.map(function (c) {
        return html`<div key=${c.name} style="background: #1B242D; border: 1px solid #26313C; border-radius: 6px; padding: 8px 10px">
          <div style="font-size: 12px; color: #93A1AE">${c.name} · ${c.where}</div>
          <div style=${'display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 13px; margin-top: 2px; ' + MONO}><span>실측 ${c.meas}</span><span>예측 ${c.pred}</span><span style=${c.diffStyle}>${c.diff}</span></div>
        </div>`;
      })}
    </div>
  </div>

  <div style="display: flex; flex-wrap: wrap; gap: 16px">
    <div style="flex: 2 1 380px; min-width: 0">
      <div style="display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-bottom: 8px"><h3 style=${h3}>침전수 탁도 — 실측 12 h · 모의조건 6 h 전망</h3><span style=${MONO + '; font-size: 12px; color: #93A1AE'}>${chart.endText}</span></div>
      <div style="display: flex; gap: 8px">
        <div aria-hidden="true" style=${'display: flex; flex-direction: column; justify-content: space-between; height: 160px; width: 34px; text-align: right; font-size: 11px; color: #93A1AE; ' + MONO}><span>${chart.yMaxText}</span><span>${chart.yMidText}</span><span>0</span></div>
        <div style="flex: 1; min-width: 0; position: relative; height: 160px; border-left: 1px solid #33404B; border-bottom: 1px solid #33404B">
          <svg role="img" aria-label=${chart.aria} viewBox="0 0 720 160" preserveAspectRatio="none" style="position: absolute; inset: 0; width: 100%; height: 100%">
            <line x1="0" y1="0.5" x2="720" y2="0.5" stroke="#26313C" stroke-width="1" vector-effect="non-scaling-stroke" />
            <line x1="0" y1="80" x2="720" y2="80" stroke="#26313C" stroke-width="1" vector-effect="non-scaling-stroke" />
            <line x1="0" y1=${chart.thrY} x2="720" y2=${chart.thrY} stroke="#E8A93A" stroke-width="1.2" stroke-dasharray="6 4" vector-effect="non-scaling-stroke" />
            <line x1="480" y1="0" x2="480" y2="160" stroke="#5B6875" stroke-width="1" vector-effect="non-scaling-stroke" />
            <polygon points=${chart.band} fill=${ACCENT} fill-opacity="0.16" />
            <polyline points=${chart.meas} fill="none" stroke="#C9D2DA" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
            <polyline points=${chart.fc} fill="none" stroke=${ACCENT} stroke-width="2" stroke-dasharray="5 3" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
          </svg>
        </div>
      </div>
      <div aria-hidden="true" style=${'position: relative; height: 16px; margin-left: 42px; font-size: 11px; color: #93A1AE; ' + MONO}>
        <span style="position: absolute; left: 0">−12 h</span>
        <span style="position: absolute; left: 33.3%; transform: translateX(-50%)">−6 h</span>
        <span style="position: absolute; left: 66.7%; transform: translateX(-50%)">현재</span>
        <span style="position: absolute; left: 83.3%; transform: translateX(-50%)">+3 h</span>
        <span style="position: absolute; right: 0">+6 h</span>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px; font-size: 12px; color: #93A1AE">
        <span style="display: flex; align-items: center; gap: 6px"><span aria-hidden="true" style="width: 16px; height: 2px; background: #C9D2DA"></span>실측 (침전수 탁도계)</span>
        <span style="display: flex; align-items: center; gap: 6px"><span aria-hidden="true" style=${'width: 16px; height: 0; border-top: 2px dashed ' + ACCENT}></span>서로게이트 예측 · 불확도 구간</span>
        <span style="display: flex; align-items: center; gap: 6px"><span aria-hidden="true" style="width: 16px; height: 0; border-top: 2px dashed #E8A93A"></span>관리목표 2.0 NTU (설정값)</span>
      </div>
    </div>

    <div style="flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 8px">
      <h3 style=${h3}>운영 권고</h3>
      ${recs.map(function (r, i) {
        return html`<div key=${i} style="display: flex; gap: 10px; align-items: flex-start; background: #1B242D; border: 1px solid #26313C; border-radius: 6px; padding: 10px 12px">
          <span style=${r.badgeStyle}>${r.lvl}</span>
          <span style="font-size: 13px; color: #D5DDE4">${r.text}</span>
        </div>`;
      })}
      <div style="font-size: 12px; color: #93A1AE">운영 판단 보조용 정보이며, 최종 조치는 정수장 운영 기준에 따릅니다.</div>
    </div>
  </div>
</section>
</div>

<div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start">

<section aria-labelledby="job-title" style=${'flex: 999 1 640px; gap: 10px; ' + panel}>
  <div style="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px">
    <h2 id="job-title" style="margin: 0; font-size: 15px; font-weight: 600">모의 이력 · 작업 큐</h2>
    <span style="font-size: 12px; color: #93A1AE">트리거: 상시 주기 · 기상특보 · 유입량 급변 · 수동 · 학습범위 이탈</span>
  </div>
  <div style="overflow-x: auto">
    <div style="min-width: 820px">
      <div style=${jobCols + '; font-size: 12px; color: #93A1AE; border-bottom: 1px solid #26313C'}>
        <span>실행 ID</span><span>요청 시각</span><span>트리거</span><span>경계조건</span><span>엔진</span><span>상태</span><span style="text-align: right">침전수 탁도</span>
      </div>
      ${s.jobs.map(function (j) {
        return html`<div key=${j.id} style=${jobCols + '; align-items: center; padding: 9px 10px; font-size: 13px; border-bottom: 1px solid #1F2830'}>
          <span style=${MONO + '; font-size: 12px'}>${j.id}</span>
          <span style=${MONO + '; font-size: 12px; color: #B9C4CE'}>${j.at}</span>
          <span style="color: #D5DDE4">${j.trig}</span>
          <span style="color: #B9C4CE; font-size: 12px">${j.bc}</span>
          <span style="color: #D5DDE4">${j.engine}</span>
          <span><span style=${jobStyle[j.kind] || jobStyle.wait}>${j.status}</span></span>
          <span style=${MONO + '; text-align: right'}>${j.result}</span>
        </div>`;
      })}
    </div>
  </div>
</section>

<section aria-labelledby="model-title" style=${'flex: 1 1 340px; gap: 12px; ' + panel}>
  <h2 id="model-title" style="margin: 0; font-size: 15px; font-weight: 600">서로게이트 모델 상태</h2>
  <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px 14px; font-size: 13px">
    <span style="color: #93A1AE">운영 모델</span><span>POD-RBF v0.3 · 정상상태 유속 · 수온 · 탁도장</span>
    <span style="color: #93A1AE">비교 모델</span><span>MeshGraphNets v0.1 · 섀도 운영</span>
    <span style="color: #93A1AE">학습 데이터</span><span>CFD 60회 (학습 40 · 조정 10 · 시험 10) + 추가 3회</span>
    <span style="color: #93A1AE">시험 오차</span><span style=${MONO}>유속장 L2 6.8 % · 탁도 MAE 0.11 NTU</span>
    <span style="color: #93A1AE">진행 중</span><span>정밀 CFD ${cfdOpen}건 → 완료 시 재학습 후보</span>
  </div>
  <div>
    <div style="display: flex; justify-content: space-between; font-size: 12px; color: #93A1AE; margin-bottom: 6px"><span>실측 대비 예측 편차 (7일 평균)</span><span style=${MONO + '; color: #E4E9EE'}>0.12 / 재학습 기준 0.30 NTU</span></div>
    <div aria-hidden="true" style="position: relative; height: 8px; background: #222C35; border-radius: 4px">
      <div style="position: absolute; left: 0; top: 0; bottom: 0; width: 40%; background: #5CC08A; border-radius: 4px"></div>
      <div style="position: absolute; left: 100%; top: -3px; width: 2px; height: 14px; margin-left: -2px; background: #E8A93A"></div>
    </div>
  </div>
  <div style="border-top: 1px solid #26313C; padding-top: 12px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #93A1AE">
    <span style="color: #C9D2DA; font-size: 13px; font-weight: 600">데이터 흐름</span>
    <span>실측 수온 · 탁도 (물종합진단처) → CFD 보정 · 모의 (용역사) → 서로게이트 학습 · 배포 (AI연구소) → 본 화면</span>
  </div>
</section>
</div>

</main>
</div>
</div>`;
    }
  }

  renderApp(html`<${App} />`, document.getElementById('app'));
})();
