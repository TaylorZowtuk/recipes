import { expect, it, vi } from "vitest";
import { reloadForSchema } from "./schemaReload";

// A service worker registration whose update finds a new worker, installing until `installed()`.
function fakeWorker() {
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
      registration.installing = worker;
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
  await done;
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
  await reloadForSchema(2, d);
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
