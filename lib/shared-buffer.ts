export const STATIONS = 9;
export const CHANNELS = 3;
export const CHANNEL_COUNT = STATIONS * CHANNELS;

export const SAMPLE_RATE = 200;
export const HISTORY_SECONDS = 600;

export const HISTORY_SAMPLES =
  SAMPLE_RATE * HISTORY_SECONDS; // 120000

export const DATA_BYTES =
  CHANNEL_COUNT * HISTORY_SAMPLES * Int32Array.BYTES_PER_ELEMENT;

export const META_BYTES =
  CHANNEL_COUNT * 4 * Int32Array.BYTES_PER_ELEMENT;

export function createSharedHistory() {
  const sab = new SharedArrayBuffer(
    DATA_BYTES + META_BYTES
  );

  const data = new Int32Array(
    sab,
    0,
    CHANNEL_COUNT * HISTORY_SAMPLES
  );

  const meta = new Int32Array(
    sab,
    DATA_BYTES,
    CHANNEL_COUNT * 4
  );

  return {
    sab,
    data,
    meta,
  };
}

export function channelOffset(channelIndex: number) {
  return channelIndex * HISTORY_SAMPLES;
}