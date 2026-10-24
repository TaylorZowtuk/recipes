import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation, useNavigationType } from "react-router";
import { AccountMenu } from "./AccountMenu";
import { useSync } from "./collection";
import { FridgeIcon, RecipesIcon, SitesIcon, WeekIcon } from "./icons";
import { useOnline } from "./online";
import { focusTitle } from "./Screen";
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
  const sync = useSync();
  const online = useOnline();
  const status = sync === undefined ? "Checking…" : syncStatus({ sync, online });
  const { key } = useLocation();
  const navigationType = useNavigationType();
  const shownKey = useRef(key);

  // After each navigation, focus moves to the new screen's title, without scrolling the window, so
  // screen readers announce it. The first screen opened, and a navigation that replaces the screen
  // (the redirect from / or a tap on the current place), leave focus where it was.
  useEffect(() => {
    if (shownKey.current === key) return;
    shownKey.current = key;
    if (navigationType === "REPLACE") return;
    focusTitle();
  }, [key, navigationType]);

  return (
    <div className="shell">
      <nav className="places" aria-label="Places">
        {tabs.map(({ to, label, icon }) => (
          <NavLink key={to} to={to} className="place">
            {icon}
            <span>{label}</span>
          </NavLink>
        ))}
        <AccountMenu placement="rail" />
      </nav>
      <Outlet />
      <p role="status" className="sync-status">
        {status}
      </p>
    </div>
  );
}
