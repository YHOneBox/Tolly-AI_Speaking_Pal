const TARGET_RATE = 16_000;
const SPEECH_START_RMS = 0.018;
const SPEECH_CONTINUE_RMS = 0.01;
const SILENCE_MS = 700;
const MIN_SPEECH_MS = 280;
const MAX_UTTERANCE_MS = 15_000;
const PREROLL_MS = 280;

type SpeechHandler = (wav: Uint8Array) => void;

export type CaptureMode = "vad" | "hold";

export class SpeechCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private paused = false;
  private mode: CaptureMode = "vad";
  private holding = false;
  private speaking = false;
  private silenceMs = 0;
  private speechMs = 0;
  private prerollMs = 0;
  private preroll: Float32Array[] = [];
  private utterance: Float32Array[] = [];
  private onUtterance: SpeechHandler;

  constructor(onUtterance: SpeechHandler) {
    this.onUtterance = onUtterance;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule("/vad-worklet.js");
    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, "vad-processor");
    this.worklet.port.onmessage = (event: MessageEvent<{ rms: number; samples: Float32Array }>) => {
      this.consume(event.data.rms, event.data.samples);
    };
    this.source.connect(this.worklet);
  }

  setMode(mode: CaptureMode): void {
    this.mode = mode;
    this.holding = false;
    this.resetBuffers();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.holding = false;
      this.resetBuffers();
    }
  }

  beginHold(): void {
    this.mode = "hold";
    this.holding = true;
    this.paused = false;
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
    this.preroll = [];
    this.utterance = [];
  }

  private consume(rms: number, samples: Float32Array): void {
    const sampleRate = this.context?.sampleRate ?? 48_000;
    const frameMs = (samples.length / sampleRate) * 1000;
    if (this.paused) {
      return;
    }

    if (this.mode === "hold") {
      if (!this.holding) {
        return;
      }
      this.utterance.push(samples);
      this.speechMs += frameMs;
      if (this.speechMs >= MAX_UTTERANCE_MS) {
        this.endHold();
      }
      return;
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
      if (rms >= SPEECH_START_RMS) {
        this.speaking = true;
        this.utterance = this.preroll.splice(0);
        this.speechMs = this.prerollMs;
        this.preroll = [];
        this.prerollMs = 0;
        this.silenceMs = 0;
      }
      return;
    }

    this.utterance.push(samples);
    this.speechMs += frameMs;
    if (rms >= SPEECH_CONTINUE_RMS) {
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
    }

    const finished = this.silenceMs >= SILENCE_MS || this.speechMs >= MAX_UTTERANCE_MS;
    if (!finished) {
      return;
    }

    const heardEnough = this.speechMs - this.silenceMs >= MIN_SPEECH_MS;
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
    for (let index = 0; index < frames; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32768;
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
