class VadProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) {
      return true;
    }

    let sum = 0;
    for (let index = 0; index < channel.length; index += 1) {
      const sample = channel[index];
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / channel.length);
    this.port.postMessage({
      rms,
      samples: channel.slice(0),
    });
    return true;
  }
}

registerProcessor("vad-processor", VadProcessor);
