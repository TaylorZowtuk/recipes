export type Sound = "chime" | "alarm";

let audio: AudioContext | undefined;

/** Wakes the audio. Call it in a tap: iOS keeps an AudioContext silent until one starts it. */
export function unlockSound() {
  audio ??= new AudioContext();
  void audio.resume();
}

function tone(context: AudioContext, type: OscillatorType, hertz: number, at: number, s: number) {
  const oscillator = new OscillatorNode(context, { type, frequency: hertz });
  const gain = new GainNode(context, { gain: 0 });
  gain.gain.linearRampToValueAtTime(0.3, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, at + s);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(at);
  oscillator.stop(at + s);
}

// A chime is two soft rising notes; an alarm is three hard beeps, which the timer store repeats.
export function ring(sound: Sound) {
  if (!audio) return;
  void audio.resume();
  const now = audio.currentTime;
  if (sound === "chime") {
    tone(audio, "sine", 660, now, 0.5);
    tone(audio, "sine", 880, now + 0.25, 0.8);
  } else {
    for (const beep of [0, 0.3, 0.6]) tone(audio, "square", 880, now + beep, 0.2);
  }
}
