let samples: Int32Array;
let seqs: Int32Array;
let hist = 120000;
let nch = 27;

function leer(ch: number, idx: number) {
  const slot = idx % hist;
  const off = ch * hist + slot;
  const a = Atomics.load(seqs, off);
  if (a !== idx) return 0;
  const v = samples[off];
  const b = Atomics.load(seqs, off);
  if (a !== b) return 0;
  return v;
}

self.onmessage = function (e: MessageEvent) {
  const m = e.data;
  if (m.type === "init") {
    samples = new Int32Array(m.samplesSab);
    seqs = new Int32Array(m.seqSab);
    hist = m.historySamples;
    nch = m.nch || 27;
    return;
  }
  if (m.type === "benchCopy") {
    const p = m.payload;
    postMessage({ type: "benchCopyOk", n: p.length });
    return;
  }
  if (m.type === "benchTx") {
    const p = m.payload;
    postMessage({ type: "benchTxOk", n: p.length });
    return;
  }
  if (m.type === "csv") {
    const ini = m.ini;
    const fin = m.fin;
    const fs = m.fs;
    let out = "sample,t_s";
    for (let c = 0; c < nch; c++) out += ",ch" + c;
    out += "\n";
    const n = Math.max(0, fin - ini);
    for (let i = 0; i < n; i++) {
      const idx = ini + i;
      let row = idx + "," + (idx / fs).toFixed(3);
      for (let c = 0; c < nch; c++) row += "," + leer(c, idx);
      out += row + "\n";
    }
    postMessage({ type: "csvOk", csv: out, id: m.id });
  }
};
