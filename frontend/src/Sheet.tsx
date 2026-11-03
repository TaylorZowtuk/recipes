import { type ReactNode, useEffect, useId, useRef } from "react";

// A modal dialog rising from the foot of the screen, titled, shown while `open`. Escape or a tap
// outside it closes it, as setting `open` false does; either way `onClose` runs once it has closed,
// so it can return focus to the page, which the open dialog makes inert.
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const sheet = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    const dialog = sheet.current;
    if (open && !dialog?.open) {
      dialog?.showModal();
      // Focus the title, so no control looks chosen before it's touched.
      heading.current?.focus();
    }
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  return (
    <>
      {/* The padding is on .sheet-body, so only a tap on the backdrop targets the dialog itself.
          Closing also needs the press to have begun there: a drag from a chip released on the backdrop
          clicks the dialog. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a tap on the backdrop; Escape closes it too. */}
      <dialog
        ref={sheet}
        className="sheet"
        aria-labelledby={`${id}-title`}
        onClose={onClose}
        onPointerDown={(event) => {
          downOnBackdrop.current = event.target === event.currentTarget;
        }}
        onClick={(event) =>
          downOnBackdrop.current &&
          event.target === event.currentTarget &&
          event.currentTarget.close()
        }
      >
        <div className="sheet-body">
          <h2 ref={heading} id={`${id}-title`} className="sheet-title" tabIndex={-1}>
            {title}
          </h2>
          {children}
        </div>
      </dialog>
    </>
  );
}
