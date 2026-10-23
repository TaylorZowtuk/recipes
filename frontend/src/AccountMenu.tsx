import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { accountMenuItems } from "./accountMenu";
import { AccountIcon } from "./icons";
import { useSession } from "./session";

// The account button and its menu: at the foot of the rail on desktop ("rail"), or in the top bar
// on phones ("top"). Both are rendered; the layout shows one.
export function AccountMenu({ placement }: { placement: "rail" | "top" }) {
  const { isEditor, email, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const whoId = useId();

  const items = () =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const close = ({ refocus }: { refocus: boolean }) => {
    setOpen(false);
    setSignOutFailed(false);
    if (refocus) button.current?.focus();
  };

  // Opening moves focus to the first item; a tap anywhere outside closes the menu.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (wrapper.current?.contains(event.target as Node)) return;
      setOpen(false);
      setSignOutFailed(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => all[(to + all.length) % all.length]?.focus();
    switch (event.key) {
      case "Escape":
        close({ refocus: true });
        break;
      case "Tab":
        close({ refocus: false });
        return; // focus moves on as usual
      case "ArrowDown":
        move(at + 1);
        break;
      case "ArrowUp":
        move(at - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(all.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutFailed(false);
    const signedOut = await signOut();
    setSigningOut(false);
    if (signedOut) close({ refocus: true });
    else setSignOutFailed(true);
  };

  return (
    <div ref={wrapper} className={`account account-${placement}`}>
      <button
        ref={button}
        type="button"
        className={placement === "rail" ? "place" : "icon-button"}
        aria-label={placement === "top" ? "Account" : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close({ refocus: false }) : setOpen(true))}
      >
        <AccountIcon />
        {placement === "rail" && <span>Account</span>}
      </button>
      {open && (
        // biome-ignore lint/a11y/noStaticElementInteractions: it passes on the menu's keys.
        <div className="account-menu" onKeyDown={onKeyDown}>
          {isEditor && (
            <p id={whoId} className="account-who">
              Signed in as <strong>{email}</strong>
            </p>
          )}
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label="Account"
            aria-describedby={isEditor ? whoId : undefined}
          >
            {accountMenuItems(isEditor).map((item) =>
              "to" in item ? (
                <Link
                  key={item.label}
                  to={item.to}
                  role="menuitem"
                  tabIndex={-1}
                  className="menu-item"
                  onClick={() => close({ refocus: false })}
                >
                  {item.label}
                </Link>
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="menu-item"
                  aria-disabled={signingOut || undefined}
                  onClick={onSignOut}
                >
                  {signingOut ? "Signing out…" : item.label}
                </button>
              ),
            )}
          </div>
          {signOutFailed && (
            <p role="alert" className="account-error">
              Couldn’t sign out. Check your connection and try again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
