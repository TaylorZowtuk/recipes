import { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { api, type Sync } from "./api/client";
import { AccountIcon, FridgeIcon, RecipesIcon, SitesIcon, WeekIcon } from "./icons";
import { syncStatus } from "./syncStatus";

const tabs = [
  { to: "/recipes", label: "Recipes", icon: <RecipesIcon /> },
  { to: "/week", label: "Week", icon: <WeekIcon /> },
  { to: "/fridge", label: "Fridge", icon: <FridgeIcon /> },
  { to: "/sites", label: "Sites", icon: <SitesIcon /> },
];

// The permanent frame: the four places as a bottom tab bar on phones or a left rail on desktop,
// around whichever screen is open.
export function Shell() {
  const [status, setStatus] = useState("Checking…");

  useEffect(() => {
    const show = (sync: Sync | null) => setStatus(syncStatus({ sync, online: navigator.onLine }));
    api.GET("/api/sync").then(
      ({ data }) => show(data ?? null),
      () => show(null),
    );
  }, []);

  return (
    <div className="shell">
      <nav className="places" aria-label="Places">
        {tabs.map(({ to, label, icon }) => (
          <NavLink key={to} to={to} className="place">
            {icon}
            <span>{label}</span>
          </NavLink>
        ))}
        <Link to="/sign-in" className="place account-rail">
          <AccountIcon />
          <span>Sign in</span>
        </Link>
      </nav>
      <Outlet />
      <p role="status" className="sync-status">
        {status}
      </p>
    </div>
  );
}
