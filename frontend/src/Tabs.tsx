import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";

// `count`, when above 0, shows as a red badge after the label: what is left to check on that tab.
type Tab = { label: string; count?: number; panel: ReactNode };

// A tab list with one panel showing. Only the selected tab is in the Tab order; the arrow keys,
// Home and End move between tabs and select them. `reveal` selects its tab whenever its `key` is
// new, and does so while rendering, so the panel is showing when the caller's effects run.
export function Tabs({
  label,
  tabs,
  reveal,
}: {
  label: string;
  tabs: Tab[];
  reveal?: { tab: number; key: string };
}) {
  const [selected, setSelected] = useState(reveal?.tab ?? 0);
  const [revealed, setRevealed] = useState(reveal?.key);
  if (reveal?.key !== revealed) {
    setRevealed(reveal?.key);
    if (reveal) setSelected(reveal.tab);
  }
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  const select = (index: number) => {
    const next = (index + tabs.length) % tabs.length;
    setSelected(next);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const target = {
      ArrowRight: selected + 1,
      ArrowLeft: selected - 1,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(target);
  };

  return (
    <>
      <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((tab, index) => (
          <button
            key={tab.label}
            ref={(button) => {
              buttons.current[index] = button;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${index}`}
            aria-selected={index === selected}
            aria-controls={`${id}-panel-${index}`}
            tabIndex={index === selected ? 0 : -1}
            // Named whole, as the hidden text around an inline-block badge was heard with a space
            // before its comma: "Ingredients , 3 to check".
            aria-label={tab.count ? `${tab.label}, ${tab.count} to check` : undefined}
            className="tab"
            onClick={() => setSelected(index)}
          >
            {tab.label}
            {!!tab.count && <span className="tab-count">{tab.count}</span>}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.label}
          role="tabpanel"
          id={`${id}-panel-${index}`}
          aria-labelledby={`${id}-tab-${index}`}
          hidden={index !== selected}
          className="tab-panel"
        >
          {tab.panel}
        </div>
      ))}
    </>
  );
}
