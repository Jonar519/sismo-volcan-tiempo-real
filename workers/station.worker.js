const SAMPLE_RATE = 200;

const STA_SIZE = 200;
const LTA_SIZE = 6000;
const PEAK_SIZE = 1000;

const ON_THRESHOLD = 4.0;
const OFF_THRESHOLD = 1.5;

const REORDER_FRAMES = 3;

// 3 canales por estación
const CHANNELS = 3;

let stationId = 0;
let sharedData = null;
let sharedMeta = null;
let historySize = 120000;

// -----------------------------------------------------
// Min heap sencillo
// -----------------------------------------------------

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    this.#up(this.items.length - 1);
  }

  peek() {
    return this.items[0];
  }

  pop() {
    if (this.items.length === 1) {
      return this.items.pop();
    }

    const root = this.items[0];
    this.items[0] = this.items.pop();
    this.#down(0);

    return root;
  }

  get size() {
    return this.items.length;
  }

  #up(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);

      if (
        this.items[parent].seq <=
        this.items[index].seq
      ) {
        break;
      }

      [this.items[parent], this.items[index]] =
        [this.items[index], this.items[parent]];

      index = parent;
    }
  }

  #down(index) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;

      let smallest = index;

      if (
        left < this.items.length &&
        this.items[left].seq <
          this.items[smallest].seq
      ) {
        smallest = left;
      }

      if (
        right < this.items.length &&
        this.items[right].seq <
          this.items[smallest].seq
      ) {
        smallest = right;
      }

      if (smallest === index) break;

      [this.items[index], this.items[smallest]] =
        [this.items[smallest], this.items[index]];

      index = smallest;
    }
  }
}

// -----------------------------------------------------
// Estado por canal
// -----------------------------------------------------

function createChannelState() {
  return {
    heap: new MinHeap(),
    seen: new Set(),

    expectedSeq: null,
    lastEmittedSeq: -1,
    maxSeenSeq: -1,

    staValues: new Float64Array(STA_SIZE),
    ltaValues: new Float64Array(LTA_SIZE),
    peakValues: new Float64Array(PEAK_SIZE),

    staIndex: 0,
    ltaIndex: 0,
    peakIndex: 0,

    staCount: 0,
    ltaCount: 0,
    peakCount: 0,

    staSum: 0,
    ltaSum: 0,

    kahanSTA: 0,
    kahanLTA: 0,

    triggered: false,
    triggerStart: 0,

    sampleSequence: 0,

    correctionCounter: 0,

    lastPeak: 0,
  };
}

const channels = [
  createChannelState(),
  createChannelState(),
  createChannelState(),
];

// -----------------------------------------------------
// Kahan
// -----------------------------------------------------

function kahanAdd(state, type, value) {
  if (type === "sta") {
    const y = value - state.kahanSTA;
    const t = state.staSum + y;

    state.kahanSTA =
      (t - state.staSum) - y;

    state.staSum = t;
  } else {
    const y = value - state.kahanLTA;
    const t = state.ltaSum + y;

    state.kahanLTA =
      (t - state.ltaSum) - y;

    state.ltaSum = t;
  }
}

// -----------------------------------------------------
// Recalculo periódico para corregir deriva
// -----------------------------------------------------

function correctSums(state) {
  let sta = 0;

  for (let i = 0; i < state.staCount; i++) {
    sta += state.staValues[i];
  }

  let lta = 0;

  for (let i = 0; i < state.ltaCount; i++) {
    lta += state.ltaValues[i];
  }

  state.staSum = sta;
  state.ltaSum = lta;

  state.kahanSTA = 0;
  state.kahanLTA = 0;
}

// -----------------------------------------------------
// Máximo móvil O(1) amortizado
// -----------------------------------------------------

class MonotonicMaxQueue {
  constructor() {
    this.values = [];
    this.head = 0;
  }

  push(sequence, value) {
    while (
      this.values.length > this.head &&
      this.values[this.values.length - 1].value <= value
    ) {
      this.values.pop();
    }

    this.values.push({
      sequence,
      value,
    });
  }

  removeBefore(minSequence) {
    while (
      this.head < this.values.length &&
      this.values[this.head].sequence <
        minSequence
    ) {
      this.head++;
    }

    if (this.head > 100 && this.head * 2 > this.values.length) {
      this.values = this.values.slice(this.head);
      this.head = 0;
    }
  }

  max() {
    return this.values[this.head]?.value ?? 0;
  }
}

const peakQueues = [
  new MonotonicMaxQueue(),
  new MonotonicMaxQueue(),
  new MonotonicMaxQueue(),
];

// -----------------------------------------------------
// Procesamiento de muestra
// -----------------------------------------------------

function processSample(
  channelIndex,
  sample,
  timestamp
) {
  const state = channels[channelIndex];

  const energy = sample * sample;

  // ---------------------------------------------
  // STA
  // ---------------------------------------------

  if (state.staCount === STA_SIZE) {
    const old =
      state.staValues[state.staIndex];

    state.staSum -= old;
  } else {
    state.staCount++;
  }

  state.staValues[state.staIndex] = energy;

  kahanAdd(state, "sta", energy);

  state.staIndex =
    (state.staIndex + 1) % STA_SIZE;

  // ---------------------------------------------
  // LTA
  //
  // IMPORTANTE:
  // mientras está disparado no se actualiza.
  // ---------------------------------------------

  if (!state.triggered) {
    if (state.ltaCount === LTA_SIZE) {
      const old =
        state.ltaValues[state.ltaIndex];

      state.ltaSum -= old;
    } else {
      state.ltaCount++;
    }

    state.ltaValues[state.ltaIndex] =
      energy;

    kahanAdd(state, "lta", energy);

    state.ltaIndex =
      (state.ltaIndex + 1) % LTA_SIZE;
  }

  // ---------------------------------------------
  // Corrección numérica periódica
  // ---------------------------------------------

  state.correctionCounter++;

  if (state.correctionCounter >= 2048) {
    correctSums(state);
    state.correctionCounter = 0;
  }

  // ---------------------------------------------
  // STA/LTA
  // ---------------------------------------------

  let ratio = 0;

  if (
    state.staCount >= STA_SIZE &&
    state.ltaCount >= LTA_SIZE &&
    state.ltaSum > 0
  ) {
    const sta =
      state.staSum / STA_SIZE;

    const lta =
      state.ltaSum / LTA_SIZE;

    ratio = sta / lta;
  }

  // ---------------------------------------------
  // Trigger con histéresis
  // ---------------------------------------------

  if (
    !state.triggered &&
    ratio >= ON_THRESHOLD
  ) {
    state.triggered = true;
    state.triggerStart = timestamp;

    postMessage({
      type: "trigger-start",
      station: stationId,
      channel: channelIndex,
      timestamp,
    });
  }

  if (
    state.triggered &&
    ratio <= OFF_THRESHOLD
  ) {
    state.triggered = false;

    postMessage({
      type: "trigger-end",
      station: stationId,
      channel: channelIndex,
      timestamp,
      start: state.triggerStart,
    });
  }

  // ---------------------------------------------
  // Máximo móvil 5 segundos
  // ---------------------------------------------

  const absolute =
    Math.abs(sample);

  const sequence =
    state.sampleSequence++;

  peakQueues[channelIndex].push(
    sequence,
    absolute
  );

  peakQueues[channelIndex].removeBefore(
    sequence - PEAK_SIZE + 1
  );

  state.lastPeak =
    peakQueues[channelIndex].max();

  // ---------------------------------------------
  // SharedArrayBuffer
  // ---------------------------------------------

  writeHistory(
    channelIndex,
    sample,
    timestamp
  );

  return {
    ratio,
    peak: state.lastPeak,
    triggered: state.triggered,
  };
}

// -----------------------------------------------------
// Escritura lock-free
// -----------------------------------------------------

function writeHistory(
  channelIndex,
  sample,
  timestamp
) {
  const metaBase = channelIndex * 4;

  const sequence =
    Atomics.load(
      sharedMeta,
      metaBase
    );

  const position =
    sequence % historySize;

  const offset =
    channelIndex * historySize +
    position;

  sharedData[offset] = sample;

  // timestamp simplificado en milisegundos
  sharedData[
    offset
  ] = sample;

  Atomics.store(
    sharedMeta,
    metaBase + 1,
    sequence + 1
  );

  Atomics.store(
    sharedMeta,
    metaBase + 2,
    timestamp
  );

  Atomics.add(
    sharedMeta,
    metaBase + 3,
    1
  );
}

// -----------------------------------------------------
// Reordenamiento
// -----------------------------------------------------

function receiveFrame(frame) {
  const channel = frame.channel;
  const state = channels[channel];

  const seq = frame.seq;

  // Duplicado o demasiado antiguo
  if (seq <= state.lastEmittedSeq) {
    postMessage({
      type: "discard",
      reason: "late",
      station: stationId,
      channel,
      seq,
    });

    return;
  }

  // Duplicado dentro de la ventana
  if (state.seen.has(seq)) {
    postMessage({
      type: "discard",
      reason: "duplicate",
      station: stationId,
      channel,
      seq,
    });

    return;
  }

  state.seen.add(seq);

  state.heap.push(frame);

  state.maxSeenSeq =
    Math.max(state.maxSeenSeq, seq);

  if (state.expectedSeq === null) {
    state.expectedSeq = seq;
  }

  flushFrames(channel);
}

function flushFrames(channel) {
  const state = channels[channel];

  while (state.heap.size > 0) {
    const first = state.heap.peek();

    if (
      first.seq === state.expectedSeq
    ) {
      state.heap.pop();
      state.seen.delete(first.seq);

      processFrame(first);

      state.lastEmittedSeq =
        first.seq;

      state.expectedSeq++;
      continue;
    }

    // Si ya tenemos 3 tramas de distancia,
    // damos por perdida la esperada.
    if (
      state.maxSeenSeq -
        state.expectedSeq >=
      REORDER_FRAMES
    ) {
      postMessage({
        type: "lost-frame",
        station: stationId,
        channel,
        seq: state.expectedSeq,
      });

      state.expectedSeq++;
      continue;
    }

    break;
  }
}

// -----------------------------------------------------
// Procesamiento de trama
// -----------------------------------------------------

function processFrame(frame) {
  const samples =
    frame.samples;

  for (
    let i = 0;
    i < samples.length;
    i++
  ) {
    const timestamp =
      frame.t0_us / 1000 +
      (i * 1000) / SAMPLE_RATE;

    processSample(
      frame.channel,
      samples[i],
      timestamp
    );
  }
}

// -----------------------------------------------------
// Mensajes
// -----------------------------------------------------

self.onmessage = (event) => {
  const message = event.data;

  if (message.type === "init") {
    stationId = message.stationId;
    sharedData = new Int32Array(
      message.sab,
      0,
      message.dataLength
    );

    sharedMeta = new Int32Array(
      message.sab,
      message.dataOffset,
      message.metaLength
    );

    historySize =
      message.historySize;

    return;
  }

  if (message.type === "frame") {
    receiveFrame(message.frame);
    return;
  }

  if (message.type === "reset") {
    for (const state of channels) {
      Object.assign(
        state,
        createChannelState()
      );
    }
  }
};