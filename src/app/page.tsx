"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

const EST = 9;
const CH_EST = 3;
const CH = EST * CH_EST;
const FS = 200;
const HIST = FS * 600;
const VENTANA6S = 6000000;

function armarTrama(est: number, ch: number, seq: number, t0: number) {
  const b = new ArrayBuffer(216);
  const v = new DataView(b);
  v.setUint16(0, est, true);
  v.setUint8(2, ch);
  v.setUint8(3, 0);
  v.setUint32(4, seq, true);
  v.setFloat64(8, t0, true);
  for (let i = 0; i < 50; i++) {
    let x = Math.sin((seq * 50 + i) * 0.08 + ch) * 1600;
    if (seq % 40 === 0 && est % 2 === 0) x += 9200;
    v.setInt32(16 + i * 4, Math.round(x), true);
  }
  return b;
}

function leer(samples: Int32Array, seqs: Int32Array, ch: number, idx: number) {
  const off = ch * HIST + (idx % HIST);
  const a = Atomics.load(seqs, off);
  if (a !== idx) return null;
  const val = samples[off];
  const b = Atomics.load(seqs, off);
  if (a !== b) return null;
  return val;
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workersRef = useRef<Worker[]>([]);
  const mapaRef = useRef<Map<number, Worker>>(new Map());
  const expRef = useRef<Worker | null>(null);
  const sabRef = useRef<{ samples: Int32Array; seqs: Int32Array; heads: Int32Array } | null>(null);
  const estRef = useRef<Map<number, { on: boolean; t: number }>>(new Map());
  const picosRef = useRef<number[]>(Array(CH).fill(0));
  const seqsSim = useRef<number[]>(Array(CH).fill(0));
  const tUsRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const modoRef = useRef("normal");
  const pausaRef = useRef(false);
  const ventRef = useRef(60);
  const offRef = useRef(0);
  const drag = useRef({ on: false, x: 0, off: 0 });

  const [iso, setIso] = useState(false);
  const [vent, setVent] = useState(60);
  const [offset, setOffset] = useState(0);
  const [modo, setModo] = useState("normal");
  const [pausa, setPausa] = useState(false);
  const [ratio, setRatio] = useState(3.2);
  const [amp, setAmp] = useState(5000);
  const [reloj, setReloj] = useState("--:--:--");
  const [inp, setInp] = useState({ v: 0, d: 0, p: 0, pr: 0, lt: 0 });
  const [bench, setBench] = useState({ copy: 0, tx: 0 });
  const [evs, setEvs] = useState<
    { id: number; sampleIndex: number; tsUs: number; estaciones: number[]; pico: number }[]
  >([]);

  function mandar(est: number, buf: ArrayBuffer) {
    const w = mapaRef.current.get(est);
    w?.postMessage({ type: "frame", buf }, [buf]);
  }

  function unCiclo(tUs: number) {
    const modoNow = modoRef.current;
    const lote: { est: number; buf: ArrayBuffer }[] = [];
    for (let est = 1; est <= EST; est++) {
      for (let c = 0; c < CH_EST; c++) {
        const g = (est - 1) * CH_EST + c;
        if (modoNow === "perdidas" && seqsSim.current[g] % 17 === 0) {
          seqsSim.current[g]++;
          continue;
        }
        const buf = armarTrama(est, c, seqsSim.current[g], tUs);
        seqsSim.current[g]++;
        lote.push({ est, buf });
      }
    }
    if (modoNow === "desorden") {
      lote.sort(() => Math.random() - 0.5);
    }
    for (const x of lote) {
      if (modoNow === "duplicados") {
        mandar(x.est, x.buf.slice(0));
      }
      mandar(x.est, x.buf);
    }
  }

  function rafaga(n: number, tUs: number) {
    if (n <= 0 || pausaRef.current) return;
    unCiclo(tUs);
    tUsRef.current = tUs + 250000;
    setTimeout(() => rafaga(n - 1, tUsRef.current), 0);
  }

  function tick() {
    if (pausaRef.current) return;
    if (modoRef.current === "rafaga") {
      rafaga(12, tUsRef.current);
      return;
    }
    unCiclo(tUsRef.current);
    tUsRef.current += 250000;
  }

  useEffect(() => {
    setIso(window.crossOriginIsolated);
    tUsRef.current = Date.now() * 1000;
    const nW = Math.max(1, Math.min(EST, (navigator.hardwareConcurrency || 4) - 1));

    const samplesSab = new SharedArrayBuffer(4 * CH * HIST);
    const seqSab = new SharedArrayBuffer(4 * CH * HIST);
    const headsSab = new SharedArrayBuffer(4 * CH);
    const samples = new Int32Array(samplesSab);
    const seqs = new Int32Array(seqSab);
    const heads = new Int32Array(headsSab);
    seqs.fill(-1);
    sabRef.current = { samples, seqs, heads };

    const grupos: number[][] = [];
    for (let i = 0; i < nW; i++) grupos.push([]);
    for (let e = 1; e <= EST; e++) grupos[(e - 1) % nW].push(e);

    workersRef.current = grupos.map((estaciones) => {
      const w = new Worker(new URL("../workers/signal.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "trigOn") {
          estRef.current.set(m.stationId, { on: true, t: m.tsUs });
          const ids: number[] = [];
          estRef.current.forEach((st, id) => {
            if (st.on && m.tsUs - st.t <= VENTANA6S) ids.push(id);
          });
          if (ids.length >= 4) {
            setEvs((prev) => {
              if (prev.length && m.sampleIndex - prev[prev.length - 1].sampleIndex < FS) return prev;
              const pico = Math.max(
                ...ids.map((id) => {
                  const b = (id - 1) * CH_EST;
                  return Math.max(picosRef.current[b], picosRef.current[b + 1], picosRef.current[b + 2]);
                }),
                0,
              );
              return [...prev.slice(-8), { id: m.sampleIndex, sampleIndex: m.sampleIndex, tsUs: m.tsUs, estaciones: ids, pico }];
            });
          }
        } else if (m.type === "trigOff") {
          estRef.current.set(m.stationId, { on: false, t: m.tsUs });
        } else if (m.type === "pico") {
          picosRef.current[m.channel] = m.peak;
        }
      };
      w.postMessage({
        type: "init",
        stations: estaciones,
        historySamples: HIST,
        channelsPerStation: CH_EST,
        samplesSab,
        seqSab,
        headsSab,
        ratioOn: 3.2,
        ampThreshold: 5000,
      });
      estaciones.forEach((e) => mapaRef.current.set(e, w));
      return w;
    });

    const exp = new Worker(new URL("../workers/export.worker.ts", import.meta.url), { type: "module" });
    exp.postMessage({ type: "init", samplesSab, seqSab, historySamples: HIST, nch: CH });
    expRef.current = exp;

    timerRef.current = window.setInterval(tick, 250);
    const clock = window.setInterval(() => setReloj(new Date().toLocaleTimeString()), 1000);

    let obs1: PerformanceObserver | null = null;
    let obs2: PerformanceObserver | null = null;
    if (PerformanceObserver.supportedEntryTypes.includes("event")) {
      obs1 = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEventTiming[]) {
          setInp((prev) => {
            if (e.duration < prev.v) return prev;
            const d = e.processingStart - e.startTime;
            const p = e.processingEnd - e.processingStart;
            const pr = Math.max(0, e.duration - (e.processingEnd - e.startTime));
            return { ...prev, v: e.duration, d, p, pr };
          });
        }
      });
      obs1.observe({ type: "event", buffered: true });
    }
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      obs2 = new PerformanceObserver((list) => {
        setInp((prev) => ({ ...prev, lt: prev.lt + list.getEntries().length }));
      });
      obs2.observe({ type: "longtask", buffered: true });
    }

    const draw = () => {
      const cv = canvasRef.current;
      const sab = sabRef.current;
      if (!cv || !sab) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      const ctx = cv.getContext("2d");
      if (!ctx) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      const wrap = cv.parentElement;
      if (wrap) {
        const r = wrap.getBoundingClientRect();
        const nw = Math.max(1, Math.floor(r.width));
        const nh = Math.max(1, Math.floor(r.height));
        if (cv.width !== nw) cv.width = nw;
        if (cv.height !== nh) cv.height = nh;
      }
      const cw = cv.width;
      const hf = cv.height / CH;

      ctx.fillStyle = "#0b0d10";
      ctx.fillRect(0, 0, cw, cv.height);

      let latest = 0;
      for (let c = 0; c < CH; c++) latest = Math.max(latest, Atomics.load(sab.heads, c));

      const win = Math.max(FS * 10, Math.floor(ventRef.current * FS));
      const fin = Math.max(0, latest - offRef.current);
      const ini = Math.max(0, fin - win);
      const spp = Math.max(1, Math.floor(win / cw));

      for (let c = 0; c < CH; c++) {
        const mid = c * hf + hf / 2;
        ctx.beginPath();
        ctx.strokeStyle = "#7f7";
        ctx.lineWidth = 1;
        for (let x = 0; x < cw; x++) {
          let mn = 1e9;
          let mx = -1e9;
          const from = ini + x * spp;
          const to = Math.min(fin, from + spp);
          for (let i = from; i < to; i++) {
            const val = leer(sab.samples, sab.seqs, c, i);
            if (val == null) {
              mn = 1e9;
              break;
            }
            if (val < mn) mn = val;
            if (val > mx) mx = val;
          }
          if (mn === 1e9) continue;
          ctx.moveTo(x, mid - mx * (hf * 0.42) / 10000);
          ctx.lineTo(x, mid - mn * (hf * 0.42) / 10000);
        }
        ctx.stroke();
        ctx.fillStyle = "#ccc";
        ctx.font = "10px sans-serif";
        ctx.fillText("E" + (Math.floor(c / 3) + 1) + "-" + (c % 3), 4, c * hf + 12);
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      clearInterval(clock);
      obs1?.disconnect();
      obs2?.disconnect();
      workersRef.current.forEach((w) => w.terminate());
      workersRef.current = [];
      expRef.current?.terminate();
      expRef.current = null;
    };
  }, []);

  function aplicarCtrl(r: number, a: number) {
    workersRef.current.forEach((w) => w.postMessage({ type: "ctrl", ratioOn: r, ampThreshold: a }));
  }

  function medir() {
    const w = expRef.current;
    if (!w) return;
    const copy = new Float32Array(250000);
    copy.fill(1.23);
    const tx = new Float32Array(250000);
    tx.fill(1.23);
    const t0 = performance.now();
    const onCopy = (ev: MessageEvent) => {
      if (ev.data?.type !== "benchCopyOk") return;
      const copyMs = performance.now() - t0;
      const t1 = performance.now();
      const onTx = (ev2: MessageEvent) => {
        if (ev2.data?.type !== "benchTxOk") return;
        setBench({ copy: copyMs, tx: performance.now() - t1 });
      };
      w.addEventListener("message", onTx, { once: true });
      w.postMessage({ type: "benchTx", payload: tx }, [tx.buffer]);
    };
    w.addEventListener("message", onCopy, { once: true });
    w.postMessage({ type: "benchCopy", payload: copy });
  }

  function exportar(evt: { id: number; sampleIndex: number }) {
    const w = expRef.current;
    if (!w) return;
    const pad = 90 * FS;
    const ini = Math.max(0, evt.sampleIndex - pad);
    const fin = evt.sampleIndex + pad;
    const onOk = (ev: MessageEvent) => {
      if (ev.data?.type !== "csvOk" || ev.data.id !== evt.id) return;
      w.removeEventListener("message", onOk);
      const blob = new Blob([ev.data.csv], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "evento-" + evt.id + ".csv";
      a.click();
      URL.revokeObjectURL(a.href);
    };
    w.addEventListener("message", onOk);
    w.postMessage({ type: "csv", ini, fin, fs: FS, id: evt.id });
  }

  return (
    <div className={styles.box}>
      <div className={styles.top}>
        <h1>Consola sismo-volcanica</h1>
        <span className={styles.kpi}>isolated: {String(iso)}</span>
        <span className={styles.kpi}>INP {inp.v.toFixed(1)} ms</span>
        <span className={styles.kpi}>long tasks {inp.lt}</span>
        <span className={styles.kpi}>{reloj}</span>
      </div>

      <div className={styles.fila}>
        <label>
          ventana {vent}s
          <input
            type="range"
            min={10}
            max={120}
            value={vent}
            onChange={(e) => {
              const n = Number(e.target.value);
              ventRef.current = n;
              setVent(n);
            }}
          />
        </label>
        <label>
          offset
          <input
            type="number"
            value={offset}
            onChange={(e) => {
              const n = Math.max(0, Number(e.target.value) || 0);
              offRef.current = n;
              setOffset(n);
            }}
          />
        </label>
        <button
          className={styles.btn}
          onClick={() => {
            offRef.current = 0;
            setOffset(0);
          }}
        >
          tiempo real
        </button>
        <label>
          generador
          <select
            value={modo}
            onChange={(e) => {
              modoRef.current = e.target.value;
              setModo(e.target.value);
            }}
          >
            <option value="normal">normal</option>
            <option value="desorden">desorden</option>
            <option value="duplicados">duplicados</option>
            <option value="perdidas">perdidas</option>
            <option value="rafaga">rafaga</option>
          </select>
        </label>
        <button
          className={pausa ? styles.btn : styles.btnRojo}
          onClick={() => {
            pausaRef.current = !pausaRef.current;
            setPausa(pausaRef.current);
          }}
        >
          {pausa ? "reconectar" : "cortar flujo"}
        </button>
        <button className={styles.btn} onClick={medir}>
          copy vs transfer
        </button>
        <label>
          ratio
          <input
            type="number"
            step="0.1"
            value={ratio}
            onChange={(e) => {
              const n = Number(e.target.value);
              setRatio(n);
              aplicarCtrl(n, amp);
            }}
          />
        </label>
        <label>
          amp
          <input
            type="number"
            value={amp}
            onChange={(e) => {
              const n = Number(e.target.value);
              setAmp(n);
              aplicarCtrl(ratio, n);
            }}
          />
        </label>
      </div>

      <div className={styles.lienzoWrap}>
        <canvas
          ref={canvasRef}
          className={styles.lienzo}
          onWheel={(e) => {
            e.preventDefault();
            const n = Math.min(120, Math.max(10, ventRef.current * (e.deltaY > 0 ? 1.1 : 0.9)));
            ventRef.current = n;
            setVent(Math.round(n));
          }}
          onMouseDown={(e) => {
            drag.current = { on: true, x: e.clientX, off: offset };
          }}
          onMouseMove={(e) => {
            if (!drag.current.on) return;
            const dx = e.clientX - drag.current.x;
            const cw = canvasRef.current?.width || 900;
            const n = Math.max(0, drag.current.off + Math.round((dx / cw) * vent * FS));
            offRef.current = n;
            setOffset(n);
          }}
          onMouseUp={() => {
            drag.current.on = false;
          }}
          onMouseLeave={() => {
            drag.current.on = false;
          }}
        />
      </div>

      <div className={styles.abajo}>
        <table className={styles.tabla}>
          <thead>
            <tr>
              <th>metrica</th>
              <th>ms</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>INP input delay</td>
              <td>{inp.d.toFixed(1)}</td>
            </tr>
            <tr>
              <td>INP processing</td>
              <td>{inp.p.toFixed(1)}</td>
            </tr>
            <tr>
              <td>INP presentation</td>
              <td>{inp.pr.toFixed(1)}</td>
            </tr>
            <tr>
              <td>postMessage copy</td>
              <td>{bench.copy.toFixed(2)}</td>
            </tr>
            <tr>
              <td>postMessage transfer</td>
              <td>{bench.tx.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
        <div className={styles.evs}>
          {evs.map((ev) => (
            <div key={ev.id} className={styles.ev}>
              <span>
                evento {new Date(ev.tsUs / 1000).toISOString()} | est {ev.estaciones.join(",")} | pico {ev.pico.toFixed(0)}
              </span>
              <button className={styles.btnCsv} onClick={() => exportar(ev)}>
                csv ±90s
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
