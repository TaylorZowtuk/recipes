import { describe, expect, it, vi } from "vitest";
import { keepScreenOn, type ScreenStatus } from "./wakeLock";

// A fake Screen Wake Lock: each request is answered by the test, and a sentinel can be released
// from outside, as the browser does when the page is hidden.
function fakeLock() {
  const requests: { resolve: () => void; reject: () => void }[] = [];
  const sentinels: (EventTarget & { release: ReturnType<typeof vi.fn> })[] = [];
  const nav = {
    wakeLock: {
      request: vi.fn(
        (_type: "screen") =>
          new Promise<EventTarget & { release: () => Promise<void> }>((resolve, reject) => {
            const sentinel = Object.assign(new EventTarget(), {
              release: vi.fn(async () => {
                sentinel.dispatchEvent(new Event("release"));
              }),
            });
            requests.push({
              resolve: () => {
                sentinels.push(sentinel);
                resolve(sentinel);
              },
              reject: () => reject(new DOMException("Refused", "NotAllowedError")),
            });
          }),
      ),
    },
  };
  return { nav, requests, sentinels };
}

function fakeDocument() {
  return Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe("keepScreenOn", () => {
  it("says the screen may turn off where there's no wake lock", () => {
    const said: ScreenStatus[] = [];
    keepScreenOn({}, fakeDocument(), (status) => said.push(status));
    expect(said).toEqual(["off"]);
  });

  it("asks, then says the screen stays on, and lets the lock go when stopped", async () => {
    const { nav, requests, sentinels } = fakeLock();
    const said: ScreenStatus[] = [];
    const stop = keepScreenOn(nav, fakeDocument(), (status) => said.push(status));
    expect(said).toEqual(["asking"]);
    expect(nav.wakeLock.request).toHaveBeenCalledWith("screen");
    requests[0]?.resolve();
    await settle();
    expect(said).toEqual(["asking", "on"]);
    stop();
    expect(sentinels[0]?.release).toHaveBeenCalled();
  });

  it("says the screen may turn off when the lock is refused", async () => {
    const { nav, requests } = fakeLock();
    const said: ScreenStatus[] = [];
    keepScreenOn(nav, fakeDocument(), (status) => said.push(status));
    requests[0]?.reject();
    await settle();
    expect(said).toEqual(["asking", "off"]);
  });

  it("asks again when the page is shown after the browser let the lock go", async () => {
    const { nav, requests, sentinels } = fakeLock();
    const doc = fakeDocument();
    const said: ScreenStatus[] = [];
    const stop = keepScreenOn(nav, doc, (status) => said.push(status));
    requests[0]?.resolve();
    await settle();

    doc.visibilityState = "hidden";
    sentinels[0]?.dispatchEvent(new Event("release"));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(said).toEqual(["asking", "on", "off"]);
    expect(nav.wakeLock.request).toHaveBeenCalledTimes(1);

    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(nav.wakeLock.request).toHaveBeenCalledTimes(2);
    requests[1]?.resolve();
    await settle();
    expect(said).toEqual(["asking", "on", "off", "on"]);

    // Shown again while the lock still holds, it doesn't ask twice.
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(nav.wakeLock.request).toHaveBeenCalledTimes(2);

    stop();
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(nav.wakeLock.request).toHaveBeenCalledTimes(2);
  });

  it("lets a lock granted after it stopped go at once, saying nothing more", async () => {
    const { nav, requests, sentinels } = fakeLock();
    const said: ScreenStatus[] = [];
    const stop = keepScreenOn(nav, fakeDocument(), (status) => said.push(status));
    stop();
    requests[0]?.resolve();
    await settle();
    expect(sentinels[0]?.release).toHaveBeenCalled();
    expect(said).toEqual(["asking"]);
  });
});
