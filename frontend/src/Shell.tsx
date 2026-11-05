import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation, useNavigationType } from "react-router";
import { AccountMenu } from "./AccountMenu";
import { useCollection, useSync } from "./collection";
import { FridgeIcon, RecipesIcon, SitesIcon, WeekIcon } from "./icons";
import { needsReview } from "./needsReview";
import { useOnline } from "./online";
import { focusTitle, hashTookFocus } from "./Screen";
import { EditorOnly } from "./session";
import { syncStatus } from "./syncStatus";
import { TimerDock } from "./TimerDock";

const tabs = [
  { to: "/recipes", label: "Recipes", icon: <RecipesIcon />, mark: <ReviewDot /> },
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
  const { key, hash } = useLocation();
  const navigationType = useNavigationType();
  const shownKey = useRef(key);

  // After each navigation, focus moves to the new screen's title, without scrolling the window, so
  // screen readers announce it. The first screen opened, and a navigation that replaces the screen
  // (the redirect from / or a tap on the current place), leave focus where it was, as does one to
  // a step that took focus, which the recipe's effect has done by now.
  useEffect(() => {
    if (shownKey.current === key) return;
    shownKey.current = key;
    if (navigationType === "REPLACE" || hashTookFocus(hash)) return;
    focusTitle();
  }, [key, hash, navigationType]);

  return (
    <div className="shell">
      <nav className="places" aria-label="Places">
        {tabs.map(({ to, label, icon, mark }) => (
          <NavLink key={to} to={to} className="place">
            {icon}
            <span>
              {label}
              {mark && <EditorOnly>{mark}</EditorOnly>}
            </span>
          </NavLink>
        ))}
        <AccountMenu placement="rail" />
      </nav>
      <Outlet />
      <p role="status" className="sync-status">
        {status}
      </p>
      <TimerDock />
    </div>
  );
}

// A dot on the Recipes tab while any card needs review, said as part of the tab's name.
function ReviewDot() {
  const collection = useCollection();
  if (collection.state !== "ready" || !collection.value.cards.some(needsReview)) return null;
  return (
    <>
      <span className="visually-hidden">(needs review)</span>
      <span className="place-dot" aria-hidden="true" />
    </>
  );
}
