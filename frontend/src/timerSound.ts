export type Sound = "chime" | "alarm";

let audio: AudioContext | undefined;
let waiting: Sound | undefined;

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
function play(context: AudioContext, sound: Sound) {
  const now = context.currentTime;
  if (sound === "chime") {
    tone(context, "sine", 660, now, 0.5);
    tone(context, "sine", 880, now + 0.25, 0.8);
  } else {
    for (const beep of [0, 0.3, 0.6]) tone(context, "square", 880, now + beep, 0.2);
  }
}

// Time stands still in audio that isn't running, so a ring waits for it to wake. Only the latest
// waits: repeats of an alarm would otherwise all play at the same instant.
export function ring(sound: Sound) {
  const context = audio;
  if (!context) return;
  if (context.state === "running") {
    play(context, sound);
    return;
  }
  waiting = sound;
  void context.resume().then(() => {
    if (waiting) play(context, waiting);
    waiting = undefined;
  });
}
