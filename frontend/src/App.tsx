import { useEffect, useState } from "react";
import { api, type Sync } from "./api/client";
import { syncStatus } from "./syncStatus";

export function App() {
  const [status, setStatus] = useState("Checking…");

  useEffect(() => {
    const show = (sync: Sync | null) => setStatus(syncStatus({ sync, online: navigator.onLine }));
    api.GET("/api/sync").then(
      ({ data }) => show(data ?? null),
      () => show(null),
    );
  }, []);

  return (
    <main>
      <h1>Plateful</h1>
      <p role="status">{status}</p>
    </main>
  );
}
