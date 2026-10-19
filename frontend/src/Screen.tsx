import { type ReactNode, useEffect } from "react";
import { NavLink, useNavigate } from "react-router";
import { backTarget } from "./back";
import { AccountIcon, BackIcon } from "./icons";

type ScreenProps = {
  title: string;
  /** A pushed screen gets a Back button beside the navigation. */
  pushed?: boolean;
  /** Draws the title large at the top of the screen, between these, instead of in the top bar. */
  hero?: { above?: ReactNode; below?: ReactNode };
  children?: ReactNode;
};

// The top bar (Back on pushed screens, the title, and on phones the account button) over a
// screen's content.
export function Screen({ title, pushed = false, hero, children }: ScreenProps) {
  const navigate = useNavigate();

  useEffect(() => {
    document.title = `${title} · Plateful`;
  }, [title]);

  const back = () => {
    // React Router keeps the history index in the entry's state, which survives a reload.
    const target = backTarget(window.history.state?.idx);
    if (target === -1) navigate(-1);
    else navigate(target, { replace: true });
  };

  const heading = (
    <h1 tabIndex={-1} className={hero ? "hero-title" : undefined}>
      {title}
    </h1>
  );

  return (
    <>
      <header className="top-bar">
        {pushed && (
          <button type="button" className="icon-button" aria-label="Back" onClick={back}>
            <BackIcon />
          </button>
        )}
        {!hero && heading}
        <NavLink to="/sign-in" className="icon-button account-top" aria-label="Sign in">
          <AccountIcon />
        </NavLink>
      </header>
      <main className="screen-body">
        {hero && (
          <header className="hero">
            {hero.above}
            {heading}
            {hero.below}
          </header>
        )}
        {children}
      </main>
    </>
  );
}
