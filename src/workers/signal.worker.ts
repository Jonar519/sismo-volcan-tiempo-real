const STA = 40;
const LTA = 1000;
const MAXWIN = 1000;
const OFF = 2.6;

let hist = 120000;
let chPorEst = 3;
let samples: Int32Array;
let seqs: Int32Array;
let heads: Int32Array;
let ratioOn = 3.2;
let ampMin = 5000;

type St = {
  nextSeq: number | null;
  cola: Trama[];
  seen: number;
  sta: Float64Array;
  lta: Float64Array;
  staI: number;
  ltaI: number;
  staN: number;
  ltaN: number;
  staSum: number;
  ltaSum: number;
  trig: boolean;
  dq: { i: number; v: number }[];
};

type Trama = {
  stationId: number;
  channel: number;
  seq: number;
  t0: number;
  samplesArr: Int32Array;
};

const canales = new Map<number, St>();
const activos = new Map<number, number>();

function stOf(ch: number): St {
  let s = canales.get(ch);
  if (s) return s;
  s = {
    nextSeq: null,
    cola: [],
    seen: -1,
    sta: new Float64Array(STA),
    lta: new Float64Array(LTA),
    staI: 0,
    ltaI: 0,
    staN: 0,
    ltaN: 0,
    staSum: 0,
    ltaSum: 0,
    trig: false,
    dq: [],
  };
  canales.set(ch, s);
  return s;
}

function parsear(buf: ArrayBuffer): Trama {
  const v = new DataView(buf);
  const samplesArr = new Int32Array(50);
  for (let i = 0; i < 50; i++) samplesArr[i] = v.getInt32(16 + i * 4, true);
  return {
    stationId: v.getUint16(0, true),
    channel: v.getUint8(2),
    seq: v.getUint32(4, true),
    t0: v.getFloat64(8, true),
    samplesArr,
  };
}

function setTrig(est: number, s: St, on: boolean, tUs: number, idx: number) {
  if (s.trig === on) return;
  s.trig = on;
  const n = activos.get(est) || 0;
  if (on) {
    activos.set(est, n + 1);
    if (n === 0) postMessage({ type: "trigOn", stationId: est, tsUs: tUs, sampleIndex: idx });
  } else {
    activos.set(est, Math.max(0, n - 1));
    if (n === 1) postMessage({ type: "trigOff", stationId: est, tsUs: tUs, sampleIndex: idx });
  }
}

function muestra(ch: number, est: number, val: number, tUs: number) {
  const s = stOf(ch);
  const abs = Math.abs(val);

  const idx = Atomics.add(heads, ch, 1);
  const slot = idx % hist;
  const off = ch * hist + slot;

  Atomics.store(seqs, off, -idx - 1);
  samples[off] = val;
  Atomics.store(seqs, off, idx);

  s.staSum -= s.sta[s.staI];
  s.sta[s.staI] = abs;
  s.staSum += abs;
  s.staI = (s.staI + 1) % STA;
  if (s.staN < STA) s.staN++;

  if (!s.trig) {
    s.ltaSum -= s.lta[s.ltaI];
    s.lta[s.ltaI] = abs;
    s.ltaSum += abs;
    s.ltaI = (s.ltaI + 1) % LTA;
    if (s.ltaN < LTA) s.ltaN++;
  }

  if (idx % 8000 === 0) {
    let a = 0;
    for (let i = 0; i < STA; i++) a += s.sta[i];
    s.staSum = a;
    if (!s.trig) {
      let b = 0;
      for (let i = 0; i < LTA; i++) b += s.lta[i];
      s.ltaSum = b;
    }
  }

  while (s.dq.length && s.dq[s.dq.length - 1].v <= abs) s.dq.pop();
  s.dq.push({ i: idx, v: abs });
  while (s.dq.length && s.dq[0].i <= idx - MAXWIN) s.dq.shift();

  const staM = s.staN ? s.staSum / s.staN : 0;
  const ltaM = s.ltaN ? s.ltaSum / s.ltaN : 1;
  const r = staM / Math.max(ltaM, 1e-6);

  if (!s.trig && r >= ratioOn && abs >= ampMin) setTrig(est, s, true, tUs, idx);
  else if (s.trig && (r < OFF || abs < ampMin * 0.8)) setTrig(est, s, false, tUs, idx);

  if ((idx & 63) === 0) {
    postMessage({
      type: "pico",
      channel: ch,
      peak: s.dq.length ? s.dq[0].v : abs,
      sampleIndex: idx,
    });
  }
}

function procesar(trama: Trama) {
  const ch = (trama.stationId - 1) * chPorEst + trama.channel;
  const s = stOf(ch);

  s.cola.push(trama);
  s.cola.sort(function (a, b) {
    if (a.t0 === b.t0) return a.seq - b.seq;
    return a.t0 - b.t0;
  });

  if (s.nextSeq === null && s.cola.length) s.nextSeq = s.cola[0].seq;

  if (s.cola.length > 40) {
    s.cola = s.cola.slice(-20);
    s.nextSeq = s.cola[0].seq;
  }

  while (s.cola.length) {
    const n = s.cola[0];
    if (s.nextSeq != null && n.seq < s.nextSeq) {
      s.cola.shift();
      continue;
    }
    if (s.nextSeq != null && n.seq !== s.nextSeq) {
      if (s.cola.length < 8) break;
      s.nextSeq = n.seq;
    }
    s.cola.shift();
    if (n.seq === s.seen) continue;
    s.seen = n.seq;
    for (let i = 0; i < n.samplesArr.length; i++) {
      muestra(ch, n.stationId, n.samplesArr[i], n.t0 + i * 5000);
    }
    s.nextSeq = n.seq + 1;
  }
}

self.onmessage = function (e: MessageEvent) {
  const m = e.data;
  if (m.type === "init") {
    hist = m.historySamples;
    chPorEst = m.channelsPerStation;
    if (m.ratioOn != null) ratioOn = m.ratioOn;
    if (m.ampThreshold != null) ampMin = m.ampThreshold;
    samples = new Int32Array(m.samplesSab);
    seqs = new Int32Array(m.seqSab);
    heads = new Int32Array(m.headsSab);
    for (let i = 0; i < (m.stations || []).length; i++) activos.set(m.stations[i], 0);
    postMessage({ type: "ok" });
    return;
  }
  if (m.type === "ctrl") {
    if (m.ratioOn != null) ratioOn = m.ratioOn;
    if (m.ampThreshold != null) ampMin = m.ampThreshold;
    return;
  }
  if (m.type === "frame") procesar(parsear(m.buf));
};
