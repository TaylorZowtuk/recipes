import { type ReactNode, useEffect } from "react";
import { useNavigate } from "react-router";
import { AccountMenu } from "./AccountMenu";
import { backTarget } from "./back";
import { BackIcon } from "./icons";

type ScreenProps = {
  title: string;
  /** A pushed screen gets a Back button beside the navigation. */
  pushed?: boolean;
  /** Draws the title large at the top of the screen, between these, instead of in the top bar. */
  hero?: { above?: ReactNode; below?: ReactNode };
  children?: ReactNode;
};

/** Moves focus to the screen's title, without scrolling the window, so screen readers announce it. */
export function focusTitle() {
  document.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
}

/** Goes one step back, or to Recipes when this screen opened the app. */
export function useBack() {
  const navigate = useNavigate();
  return () => {
    // React Router keeps the history index in the entry's state, which survives a reload.
    const target = backTarget(window.history.state?.idx);
    if (target === -1) navigate(-1);
    else navigate(target, { replace: true });
  };
}

// The top bar (Back on pushed screens, the title, and on phones the account button) over a
// screen's content.
export function Screen({ title, pushed = false, hero, children }: ScreenProps) {
  useEffect(() => {
    document.title = `${title} · Plateful`;
  }, [title]);

  const back = useBack();

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
        <AccountMenu placement="top" />
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
