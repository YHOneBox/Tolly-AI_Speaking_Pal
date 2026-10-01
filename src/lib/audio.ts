const TARGET_RATE = 16_000;
const SPEECH_START_RMS = 0.018;
const BARGE_START_RMS = 0.06;
const SPEECH_CONTINUE_RMS = 0.01;
const SILENCE_MS = 700;
const MIN_SPEECH_MS = 280;
const MIN_VOICED_MS = 140;
const SPEECH_VOICE_MS = 160;
const BARGE_VOICE_MS = 280;
const MAX_UTTERANCE_MS = 15_000;
const PREROLL_MS = 280;
const CHECK_MS = 24;
const WINDOW_MS = 32;
const VOICE_SCORE = 0.3;

type SpeechHandler = (wav: Uint8Array) => void;

async function openMicrophone(): Promise<MediaStream> {
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { ...audio, voiceIsolation: true } as MediaTrackConstraints,
      video: false,
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio, video: false });
  }
}

function isSpeech(samples: Float32Array, sampleRate: number, minRms: number): boolean {
  const length = samples.length;
  if (length < sampleRate * 0.02) {
    return false;
  }
  let sum = 0;
  let energy = 0;
  let crossings = 0;
  let previous = samples[0] ?? 0;
  for (let index = 0; index < length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample;
    energy += sample * sample;
    if (index > 0 && (sample >= 0) !== (previous >= 0)) {
      crossings += 1;
    }
    previous = sample;
  }
  if (Math.sqrt(energy / length) < minRms) {
    return false;
  }
  const zeroCrossingRate = crossings / Math.max(1, length - 1);
  if (zeroCrossingRate > 0.22) {
    return false;
  }
  return pitchScore(samples, length, sampleRate, sum / length) >= VOICE_SCORE;
}

function pitchScore(samples: Float32Array, length: number, sampleRate: number, mean: number): number {
  const minLag = Math.max(2, Math.floor(sampleRate / 400));
  const maxLag = Math.min(length - 2, Math.floor(sampleRate / 80));
  if (maxLag <= minLag) {
    return 0;
  }
  let energy = 0;
  for (let index = 0; index < length; index += 1) {
    const sample = (samples[index] ?? 0) - mean;
    energy += sample * sample;
  }
  if (energy < 1e-8) {
    return 0;
  }
  let best = 0;
  let total = 0;
  let count = 0;
  for (let lag = minLag; lag <= maxLag; lag += 2) {
    let correlation = 0;
    const limit = length - lag;
    for (let index = 0; index < limit; index += 2) {
      correlation += ((samples[index] ?? 0) - mean) * ((samples[index + lag] ?? 0) - mean);
    }
    correlation *= 2;
    total += correlation;
    count += 1;
    if (correlation > best) {
      best = correlation;
    }
  }
  if (count === 0 || best <= 0) {
    return 0;
  }
  const average = total / count;
  if (best < average * 1.6) {
    return 0;
  }
  return best / energy;
}

export class SpeechCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private paused = false;
  private holding = false;
  private bargeIn = false;
  private speaking = false;
  private silenceMs = 0;
  private speechMs = 0;
  private prerollMs = 0;
  private preroll: Float32Array[] = [];
  private utterance: Float32Array[] = [];
  private recent: Float32Array[] = [];
  private recentSamples = 0;
  private sinceCheckMs = 0;
  private voicedRunMs = 0;
  private voicedMs = 0;
  private onUtterance: SpeechHandler;
  private onSpeechStart: () => void;

  constructor(onUtterance: SpeechHandler, onSpeechStart: () => void = () => undefined) {
    this.onUtterance = onUtterance;
    this.onSpeechStart = onSpeechStart;
  }

  async start(): Promise<void> {
    this.stream = await openMicrophone();
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule("/vad-worklet.js");
    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, "vad-processor");
    this.worklet.port.onmessage = (event: MessageEvent<{ rms: number; samples: Float32Array }>) => {
      this.consume(event.data.rms, event.data.samples);
    };
    this.source.connect(this.worklet);
  }

  setBargeIn(enabled: boolean): void {
    this.bargeIn = enabled;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.holding = false;
      this.resetBuffers();
    }
  }

  beginHold(): void {
    this.holding = true;
    this.paused = false;
    this.bargeIn = false;
    this.resetBuffers();
    this.holding = true;
  }

  endHold(): boolean {
    if (!this.holding) {
      return false;
    }
    this.holding = false;
    const sampleRate = this.context?.sampleRate ?? 48_000;
    const speechMs = this.speechMs;
    const captured = concatFloats(this.utterance);
    this.resetBuffers();
    if (speechMs < MIN_SPEECH_MS || captured.length === 0) {
      return false;
    }
    this.onUtterance(encodeWav(downsample(captured, sampleRate, TARGET_RATE), TARGET_RATE));
    return true;
  }

  async stop(): Promise<void> {
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") {
      await this.context.close();
    }
    this.worklet = null;
    this.source = null;
    this.stream = null;
    this.context = null;
    this.resetBuffers();
  }

  private resetBuffers(): void {
    this.speaking = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.prerollMs = 0;
    this.voicedRunMs = 0;
    this.voicedMs = 0;
    this.sinceCheckMs = 0;
    this.preroll = [];
    this.utterance = [];
    this.recent = [];
    this.recentSamples = 0;
  }

  private remember(samples: Float32Array): void {
    this.recent.push(samples);
    this.recentSamples += samples.length;
    const sampleRate = this.context?.sampleRate ?? 48_000;
    const maxSamples = Math.floor(sampleRate * (WINDOW_MS / 1000));
    while (this.recentSamples > maxSamples && this.recent.length > 1) {
      const removed = this.recent.shift();
      if (removed) {
        this.recentSamples -= removed.length;
      }
    }
  }

  private copyWindow(): Float32Array {
    const window = new Float32Array(this.recentSamples);
    let offset = 0;
    for (const chunk of this.recent) {
      window.set(chunk, offset);
      offset += chunk.length;
    }
    return window;
  }

  private consume(rms: number, samples: Float32Array): void {
    const sampleRate = this.context?.sampleRate ?? 48_000;
    const frameMs = (samples.length / sampleRate) * 1000;
    if (this.paused) {
      return;
    }

    if (this.holding) {
      this.utterance.push(samples);
      this.speechMs += frameMs;
      if (this.speechMs >= MAX_UTTERANCE_MS) {
        this.endHold();
      }
      return;
    }

    this.remember(samples);
    this.sinceCheckMs += frameMs;
    const ready = this.sinceCheckMs >= CHECK_MS && this.recentSamples >= sampleRate * 0.02;
    let heardVoice = false;
    let checkedMs = 0;
    if (ready) {
      checkedMs = this.sinceCheckMs;
      this.sinceCheckMs = 0;
      const minRms = this.bargeIn ? BARGE_START_RMS : this.speaking ? SPEECH_CONTINUE_RMS : SPEECH_START_RMS;
      heardVoice = isSpeech(this.copyWindow(), sampleRate, minRms);
    }

    if (!this.speaking) {
      this.preroll.push(samples);
      this.prerollMs += frameMs;
      while (this.prerollMs > PREROLL_MS && this.preroll.length > 1) {
        const removed = this.preroll.shift();
        if (removed) {
          this.prerollMs -= (removed.length / sampleRate) * 1000;
        }
      }
      if (!ready) {
        return;
      }
      if (heardVoice) {
        this.voicedRunMs += checkedMs;
      } else {
        this.voicedRunMs = 0;
      }
      const need = this.bargeIn ? BARGE_VOICE_MS : SPEECH_VOICE_MS;
      if (this.voicedRunMs < need) {
        return;
      }
      if (this.bargeIn) {
        this.bargeIn = false;
        this.onSpeechStart();
      }
      this.speaking = true;
      this.utterance = this.preroll.splice(0);
      this.speechMs = this.prerollMs;
      this.voicedMs = this.voicedRunMs;
      this.preroll = [];
      this.prerollMs = 0;
      this.silenceMs = 0;
      return;
    }

    this.utterance.push(samples);
    this.speechMs += frameMs;
    if (heardVoice) {
      this.voicedMs += checkedMs;
    }
    if (rms >= SPEECH_CONTINUE_RMS) {
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
    }

    const finished = this.silenceMs >= SILENCE_MS || this.speechMs >= MAX_UTTERANCE_MS;
    if (!finished) {
      return;
    }

    const heardEnough = this.speechMs - this.silenceMs >= MIN_SPEECH_MS && this.voicedMs >= MIN_VOICED_MS;
    const captured = concatFloats(this.utterance);
    this.resetBuffers();
    if (!heardEnough) {
      return;
    }
    const downsampled = downsample(captured, sampleRate, TARGET_RATE);
    this.onUtterance(encodeWav(downsampled, TARGET_RATE));
  }
}

export class PcmPlayer {
  private context: AudioContext | null = null;
  private nextTime = 0;
  private nodes: AudioBufferSourceNode[] = [];
  private gain = 1;

  setVolume(level: number): void {
    const clamped = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 1;
    this.gain = clamped * clamped;
  }

  resume(): void {
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext();
    }
    void this.context.resume();
  }

  stop(): void {
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        // The buffer may already have ended.
      }
    }
    this.nodes = [];
    this.nextTime = 0;
  }

  enqueue(pcm: Uint8Array, sampleRate: number): void {
    const context = this.context ?? new AudioContext();
    this.context = context;
    const usable = pcm.byteLength - (pcm.byteLength % 2);
    if (usable < 2) {
      return;
    }
    const view = new DataView(pcm.buffer, pcm.byteOffset, usable);
    const frames = usable / 2;
    const buffer = context.createBuffer(1, frames, sampleRate);
    const channel = buffer.getChannelData(0);
    const gain = this.gain;
    for (let index = 0; index < frames; index += 1) {
      channel[index] = (view.getInt16(index * 2, true) / 32768) * gain;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.03, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.nodes.push(source);
    source.onended = () => {
      this.nodes = this.nodes.filter((node) => node !== source);
    };
  }

  async waitUntilDone(): Promise<void> {
    if (!this.context) {
      return;
    }
    const remaining = this.nextTime - this.context.currentTime;
    if (remaining <= 0) {
      return;
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, remaining * 1000 + 40);
    });
  }
}

export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatFloats(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) {
    return input;
  }
  const ratio = inRate / outRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let sample = start; sample < end; sample += 1) {
      sum += input[sample] ?? 0;
    }
    output[index] = sum / (end - start);
  }
  return output;
}

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
