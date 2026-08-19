// Pure-TypeScript port of Whisper-style log-mel feature extraction, needed because smart-turn
// v3's ONNX model takes a [1, 80, 800] log-mel spectrogram as `input_features`, not raw PCM
// (discovered in Task 6 Step 1 — see turn.ts's header comment and task-6-report.md).
//
// Ported from pipecat-ai/pipecat's vendored numpy implementation:
//   https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/audio/turn/smart_turn/_whisper_features.py
// (BSD-2-Clause, Copyright (c) 2024-2026, Daily), itself vendored from
// `transformers.WhisperFeatureExtractor` / `transformers.audio_utils` (Apache-2.0, Hugging
// Face) "so Smart Turn v3 can compute features without importing the `transformers` package."
// This file is an independent TypeScript port written against that source, with attribution;
// every constant and step below follows it exactly (400-point FFT, hop 160, 80 Slaney-scale
// mel filters, log10 with an 8-decade floor below the peak, final (x+4)/4 rescale).
//
// FFT approach: this precomputes exact 400-point real-DFT twiddles (restricted to the 201 bins
// rfft needs) and does a direct O(N^2)-per-frame sum. Zero-padding each 400-sample frame to 512
// and running a radix-2 FFT was rejected: it would NOT reproduce the reference's 400-point
// rfft — it samples a different frequency grid (bins every 16000/512 = 31.25 Hz, 257 of them)
// than the reference's 201 bins spaced 16000/400 = 40 Hz apart, which the mel filterbank below
// is built to match exactly. That is not the only way to get an *exact* result, though: 400 =
// 2^4 x 5^2 factors cleanly for an O(N log N) mixed-radix Cooley-Tukey FFT, and Bluestein's
// algorithm (chirp-z transform via convolution) computes an exact DFT for any N. Either would
// have been correct; the direct O(N^2) sum was chosen instead purely for implementation
// simplicity — no butterfly/bit-reversal/chirp-sequence logic to get subtly wrong — at an
// acceptable measured cost (~90-100ms per 8s window, off any per-frame-realtime hot path; see
// task-6-report.md). Worth revisiting (e.g. a real mixed-radix FFT) if this becomes a
// bottleneck for the real call pattern.

const SAMPLING_RATE = 16000;
const N_FFT = 400;
const HOP_LENGTH = 160;
const N_MELS = 80;
const N_FREQ_BINS = N_FFT / 2 + 1; // 201
const NUM_FRAMES = 800; // 8s @ 16kHz, hop 160 -> 801 raw frames; reference drops the trailing one
const N_SAMPLES = SAMPLING_RATE * 8; // 128000
const MEL_FLOOR = 1e-10;
const NORM_VARIANCE_EPS = 1e-7;

// --- Slaney mel scale (transformers.audio_utils.hertz_to_mel/mel_to_hertz, mel_scale="slaney") ---

function hertzToMelSlaney(freq: number): number {
  const minLogHertz = 1000.0;
  const minLogMel = 15.0;
  const logstep = 27.0 / Math.log(6.4);
  return freq >= minLogHertz ? minLogMel + Math.log(freq / minLogHertz) * logstep : (3.0 * freq) / 200.0;
}

function melToHertzSlaney(mel: number): number {
  const minLogHertz = 1000.0;
  const minLogMel = 15.0;
  const logstep = Math.log(6.4) / 27.0;
  return mel >= minLogMel ? minLogHertz * Math.exp(logstep * (mel - minLogMel)) : (200.0 * mel) / 3.0;
}

// --- Triangular mel filterbank, Slaney-area-normalized (transformers.audio_utils.mel_filter_bank) ---

function buildMelFilterbank(): Float64Array[] {
  const nPoints = N_MELS + 2; // 82
  const melMin = hertzToMelSlaney(0);
  const melMax = hertzToMelSlaney(SAMPLING_RATE / 2);
  const filterFreqs = new Float64Array(nPoints);
  for (let i = 0; i < nPoints; i++) {
    filterFreqs[i] = melToHertzSlaney(melMin + ((melMax - melMin) * i) / (nPoints - 1));
  }
  const fftFreqs = new Float64Array(N_FREQ_BINS);
  for (let i = 0; i < N_FREQ_BINS; i++) fftFreqs[i] = (SAMPLING_RATE / 2) * (i / (N_FREQ_BINS - 1));
  const filterDiff = new Float64Array(nPoints - 1);
  for (let i = 0; i < nPoints - 1; i++) filterDiff[i] = filterFreqs[i + 1] - filterFreqs[i];

  const filters: Float64Array[] = [];
  for (let f = 0; f < N_FREQ_BINS; f++) {
    const row = new Float64Array(N_MELS);
    for (let k = 0; k < N_MELS; k++) {
      const down = -(filterFreqs[k] - fftFreqs[f]) / filterDiff[k];
      const up = (filterFreqs[k + 2] - fftFreqs[f]) / filterDiff[k + 1];
      row[k] = Math.max(0, Math.min(down, up));
    }
    filters.push(row);
  }
  for (let k = 0; k < N_MELS; k++) {
    const enorm = 2.0 / (filterFreqs[k + 2] - filterFreqs[k]);
    for (let f = 0; f < N_FREQ_BINS; f++) filters[f][k] *= enorm;
  }
  return filters; // filters[f][k]: f = freq bin 0..200, k = mel bin 0..79
}

const MEL_FILTERS = buildMelFilterbank();

// --- Periodic Hann window (matches np.hanning(N+1)[:-1], i.e. torch.hann_window(N, periodic=True)) ---

function periodicHannWindow(length: number): Float64Array {
  const w = new Float64Array(length);
  for (let n = 0; n < length; n++) w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / length);
  return w;
}

const HANN_WINDOW = periodicHannWindow(N_FFT);

// --- Precomputed exact 400-point real-DFT twiddles, restricted to the 201 bins rfft needs ---

const DFT_COS = new Float64Array(N_FREQ_BINS * N_FFT);
const DFT_SIN = new Float64Array(N_FREQ_BINS * N_FFT);
for (let k = 0; k < N_FREQ_BINS; k++) {
  for (let n = 0; n < N_FFT; n++) {
    const angle = (2 * Math.PI * k * n) / N_FFT;
    DFT_COS[k * N_FFT + n] = Math.cos(angle);
    DFT_SIN[k * N_FFT + n] = Math.sin(angle);
  }
}

/** Power spectrum (|X[k]|^2, k=0..200) of one Hann-windowed 400-sample frame. */
function framePower(windowed: Float64Array, out: Float64Array, outOffset: number): void {
  for (let k = 0; k < N_FREQ_BINS; k++) {
    let re = 0;
    let im = 0;
    const base = k * N_FFT;
    for (let n = 0; n < N_FFT; n++) {
      re += windowed[n] * DFT_COS[base + n];
      im -= windowed[n] * DFT_SIN[base + n]; // exp(-i*theta) = cos(theta) - i*sin(theta)
    }
    out[outOffset + k] = re * re + im * im;
  }
}

// --- Reflect padding (matches np.pad(..., mode="reflect"): mirrors without repeating the edge) ---

function reflectPad(x: Float64Array, pad: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) out[i] = x[pad - i];
  out.set(x, pad);
  for (let i = 0; i < pad; i++) out[pad + n + i] = x[n - 2 - i];
  return out;
}

// --- Zero-mean unit-variance waveform normalization (transformers' do_normalize=True path) ---

function zeroMeanUnitVarNorm(x: Float32Array): Float32Array {
  const n = x.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += x[i];
  const mean = sum / n;
  let sqSum = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i] - mean;
    sqSum += d * d;
  }
  const denom = Math.sqrt(sqSum / n + NORM_VARIANCE_EPS);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (x[i] - mean) / denom;
  return out;
}

/**
 * Compute Whisper-style log-mel features for smart-turn v3.
 *
 * Pads/truncates the input to exactly 128000 samples (8s @ 16kHz): zero-padded at the END if
 * shorter, truncated to the leading 128000 samples if longer — matching the reference's own
 * internal fallback exactly (`compute_whisper_log_mel_features`'s own pad/truncate, which in
 * the real pipeline is a no-op because its caller already pre-selected a trailing 8s window).
 * Callers that want "keep the most recent 8s" windowing (as turn.ts does) must do that
 * trailing-window selection themselves before calling this function.
 *
 * Returns a flattened [80, 800] row-major Float32Array (index = mel * 800 + frame), matching
 * the ONNX model's `input_features` tensor layout for shape [1, 80, 800].
 */
export function melSpectrogram(pcm16k: Float32Array): Float32Array {
  let x: Float32Array;
  if (pcm16k.length === N_SAMPLES) {
    x = pcm16k;
  } else if (pcm16k.length < N_SAMPLES) {
    x = new Float32Array(N_SAMPLES);
    x.set(pcm16k, 0);
  } else {
    x = pcm16k.subarray(0, N_SAMPLES);
  }

  const normalized = zeroMeanUnitVarNorm(x);
  const padded = reflectPad(new Float64Array(normalized), N_FFT / 2);

  const power = new Float64Array(NUM_FRAMES * N_FREQ_BINS);
  const frame = new Float64Array(N_FFT);
  for (let t = 0; t < NUM_FRAMES; t++) {
    const offset = t * HOP_LENGTH;
    for (let n = 0; n < N_FFT; n++) frame[n] = padded[offset + n] * HANN_WINDOW[n];
    framePower(frame, power, t * N_FREQ_BINS);
  }

  const logMel = new Float64Array(N_MELS * NUM_FRAMES);
  let maxVal = -Infinity;
  for (let t = 0; t < NUM_FRAMES; t++) {
    for (let m = 0; m < N_MELS; m++) {
      let sum = 0;
      for (let f = 0; f < N_FREQ_BINS; f++) sum += MEL_FILTERS[f][m] * power[t * N_FREQ_BINS + f];
      const v = Math.log10(Math.max(MEL_FLOOR, sum));
      logMel[m * NUM_FRAMES + t] = v;
      if (v > maxVal) maxVal = v;
    }
  }

  const out = new Float32Array(N_MELS * NUM_FRAMES);
  const floor = maxVal - 8.0;
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(logMel[i], floor) + 4.0) / 4.0;
  return out;
}
