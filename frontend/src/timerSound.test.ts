import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An AudioContext whose `resume` waits for `wake`, as iOS keeps one suspended until a tap.
class FakeContext {
  state = "suspended";
  currentTime = 0;
  destination = {};
  resume = vi.fn(() => woken);
}

class FakeOscillator {
  frequency: number;
  type: string;
  start = vi.fn();
  stop = vi.fn();
  connect = () => ({ connect: () => {} });
  constructor(_: unknown, options: { type: string; frequency: number }) {
    this.type = options.type;
    this.frequency = options.frequency;
    tones.push(this);
  }
}

class FakeGain {
  gain = { linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
}

let tones: FakeOscillator[];
let wake: () => void;
let woken: Promise<void>;

describe("the timer sound", () => {
  let context: FakeContext;
  let sound: typeof import("./timerSound");

  const settled = () => new Promise((resolve) => setTimeout(resolve));

  beforeEach(async () => {
    tones = [];
    woken = new Promise((resolve) => {
      wake = () => {
        context.state = "running";
        resolve();
      };
    });
    vi.stubGlobal(
      "AudioContext",
      class extends FakeContext {
        constructor() {
          super();
          context = this;
        }
      },
    );
    vi.stubGlobal("OscillatorNode", FakeOscillator);
    vi.stubGlobal("GainNode", FakeGain);
    vi.resetModules();
    sound = await import("./timerSound");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays silent until a tap has made the audio", () => {
    sound.ring("alarm");
    expect(tones).toEqual([]);
  });

  it("plays at once on running audio", () => {
    sound.unlockSound();
    context.state = "running";
    sound.ring("chime");
    expect(tones.map((tone) => tone.type)).toEqual(["sine", "sine"]);
    sound.ring("alarm");
    expect(tones.map((tone) => tone.type)).toEqual(["sine", "sine", "square", "square", "square"]);
  });

  it("waits for suspended audio to wake, then plays", async () => {
    sound.unlockSound();
    sound.ring("alarm");
    expect(tones).toEqual([]);
    context.currentTime = 12;
    wake();
    await settled();
    expect(tones).toHaveLength(3);
    expect(tones[0]?.start).toHaveBeenCalledWith(12);
  });

  it("keeps one ring waiting, however many come due, and it's the latest", async () => {
    sound.unlockSound();
    sound.ring("chime");
    sound.ring("alarm");
    sound.ring("alarm");
    wake();
    await settled();
    expect(tones.map((tone) => tone.type)).toEqual(["square", "square", "square"]);
  });

  it("waits again if the audio is suspended after a ring has played", async () => {
    sound.unlockSound();
    sound.ring("chime");
    wake();
    await settled();
    context.state = "suspended";
    sound.ring("chime");
    await settled();
    expect(tones).toHaveLength(4);
  });
});
