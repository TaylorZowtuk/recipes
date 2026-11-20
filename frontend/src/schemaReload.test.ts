import { expect, it, vi } from "vitest";
import { reloadForSchema } from "./schemaReload";

// A service worker registration whose update finds a new worker, installing until `installed()`,
// unless `found` is false: the server still has the old build.
function fakeWorker({ found = true } = {}) {
  const steps: string[] = [];
  const container = new EventTarget();
  const worker = Object.assign(new EventTarget(), {
    state: "installing",
    postMessage(message: unknown) {
      steps.push(`message ${JSON.stringify(message)}`);
      queueMicrotask(() => {
        steps.push("controllerchange");
        container.dispatchEvent(new Event("controllerchange"));
      });
    },
  });
  const registration = {
    installing: null as typeof worker | null,
    waiting: null as typeof worker | null,
    async update() {
      steps.push("update");
      if (found) registration.installing = worker;
    },
  };
  const installed = () => {
    worker.state = "installed";
    registration.installing = null;
    registration.waiting = worker;
    worker.dispatchEvent(new Event("statechange"));
  };
  const serviceWorker = Object.assign(container, { getRegistration: async () => registration });
  return { steps, serviceWorker, installed };
}

function deps(serviceWorker?: unknown) {
  const steps: string[] = [];
  const stored = new Map<string, string>();
  return {
    steps,
    stored,
    deps: {
      serviceWorker: serviceWorker as ServiceWorkerContainer | undefined,
      deleteCache: async (name: string) => void steps.push(`delete ${name}`),
      reload: () => steps.push("reload"),
      cooking: () => false,
      storage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
      },
    },
  };
}

it("updates the service worker, lets the new one take over, then drops the caches and reloads", async () => {
  const sw = fakeWorker();
  const { steps, deps: d } = deps(sw.serviceWorker);
  const done = reloadForSchema(2, d);
  await vi.waitFor(() => expect(sw.steps).toEqual(["update"]));
  expect(steps).toEqual([]);

  sw.installed();
  expect(await done).toBe(true);
  expect(sw.steps).toEqual(["update", 'message {"type":"SKIP_WAITING"}', "controllerchange"]);
  expect(steps).toEqual([
    "delete plateful-data",
    "delete plateful-cards",
    "delete plateful-photos",
    "reload",
  ]);
});

it("drops the caches and reloads where there is no service worker", async () => {
  const { steps, deps: d } = deps(undefined);
  expect(await reloadForSchema(2, d)).toBe(true);
  expect(steps).toEqual([
    "delete plateful-data",
    "delete plateful-cards",
    "delete plateful-photos",
    "reload",
  ]);
});

it("reloads once per schema version, so a page still served the old build can't loop", async () => {
  const { steps, stored, deps: d } = deps(undefined);
  await reloadForSchema(2, d);
  await reloadForSchema(2, d);
  expect(steps.filter((step) => step === "reload")).toHaveLength(1);
  expect(stored.get("plateful.reloadedForSchema")).toBe("2");

  await reloadForSchema(3, d);
  expect(steps.filter((step) => step === "reload")).toHaveLength(2);
});

it("leaves the caches and the page alone while the server still has the old build", async () => {
  const sw = fakeWorker({ found: false });
  const { steps, stored, deps: d } = deps(sw.serviceWorker);
  expect(await reloadForSchema(2, d)).toBe(false);
  expect(steps).toEqual([]);
  expect(stored.has("plateful.reloadedForSchema")).toBe(false);

  // A later try, once the new build is up, still reloads.
  const later = fakeWorker();
  const { steps: laterSteps, deps: laterDeps } = deps(later.serviceWorker);
  laterDeps.storage = d.storage;
  const done = reloadForSchema(2, laterDeps);
  await vi.waitFor(() => expect(later.steps).toEqual(["update"]));
  later.installed();
  expect(await done).toBe(true);
  expect(laterSteps).toContain("reload");
});

it("doesn't reload when it can't keep the once-per-version mark", async () => {
  const { steps, deps: d } = deps(undefined);
  const broken = () => {
    throw new DOMException("denied", "SecurityError");
  };
  d.storage = { getItem: broken, setItem: broken };
  expect(await reloadForSchema(2, d)).toBe(false);
  expect(steps).toEqual([]);

  d.storage = { getItem: () => null, setItem: broken };
  expect(await reloadForSchema(2, d)).toBe(false);
  expect(steps).toEqual([]);
});

it("waits while cooking mode is open, then reloads on a try after it closes", async () => {
  const sw = fakeWorker();
  const { steps, stored, deps: d } = deps(sw.serviceWorker);
  d.cooking = () => true;
  expect(await reloadForSchema(2, d)).toBe(false);
  expect(sw.steps).toEqual([]);
  expect(steps).toEqual([]);
  expect(stored.has("plateful.reloadedForSchema")).toBe(false);

  d.cooking = () => false;
  const done = reloadForSchema(2, d);
  await vi.waitFor(() => expect(sw.steps).toEqual(["update"]));
  sw.installed();
  expect(await done).toBe(true);
  expect(steps).toContain("reload");
});

it("doesn't take over if cooking mode opened while the new worker installed", async () => {
  const sw = fakeWorker();
  const { steps, deps: d } = deps(sw.serviceWorker);
  let cooking = false;
  d.cooking = () => cooking;
  const done = reloadForSchema(2, d);
  await vi.waitFor(() => expect(sw.steps).toEqual(["update"]));
  cooking = true;
  sw.installed();
  expect(await done).toBe(false);
  expect(sw.steps).toEqual(["update"]);
  expect(steps).toEqual([]);
});
