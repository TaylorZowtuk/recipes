import { useEffect, useState } from "react";
import { api } from "./api/client";
import { syncStatus } from "./syncStatus";

export function App() {
  const [status, setStatus] = useState("Checking…");

  useEffect(() => {
    api.GET("/api/sync").then(
      ({ data }) => setStatus(data ? syncStatus(data) : "Editing is paused."),
      () => setStatus("Editing is paused."),
    );
  }, []);

  return (
    <main>
      <h1>Plateful</h1>
      <p role="status">{status}</p>
    </main>
  );
}
