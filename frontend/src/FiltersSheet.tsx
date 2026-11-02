import { type Ref, useId } from "react";
import { type CardFilters, isChosen, noFilters, toggleTag } from "./cardFilters";

const DIFFICULTIES: [number | null, string][] = [
  [null, "Any"],
  [4, "4"],
  [5, "5"],
  [6, "6"],
  [7, "7"],
];
const TIMES: [number | null, string][] = [
  [null, "Any"],
  [900, "15 min"],
  [1800, "30 min"],
  [2700, "45 min"],
  [3600, "1 hr"],
  [7200, "2 hr"],
];

// One Tag as a toggle button: pressed while it's one of the chosen Tags.
export function TagChip({
  tag,
  filters,
  onChange,
}: {
  tag: string;
  filters: CardFilters;
  onChange: (filters: CardFilters) => void;
}) {
  return (
    <button
      type="button"
      className="chip"
      aria-pressed={isChosen(filters, tag)}
      onClick={() => onChange(toggleTag(filters, tag))}
    >
      {tag}
    </button>
  );
}

type SheetProps = {
  tags: string[];
  filters: CardFilters;
  onChange: (filters: CardFilters) => void;
  onClose: () => void;
  ref: Ref<HTMLDialogElement>;
};

// The Filters sheet, a modal dialog the Recipes tab opens. Every change applies at once; Clear
// empties every filter and Done, Escape or a tap outside it closes it.
export function FiltersSheet({ tags, filters, onChange, onClose, ref }: SheetProps) {
  const id = useId();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a tap on the backdrop; Escape closes it too.
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onClick={(event) => event.target === event.currentTarget && event.currentTarget.close()}
    >
      {/* Opening the sheet focuses its title, so no control looks chosen before it's touched. */}
      <h2 id={`${id}-title`} className="sheet-title" tabIndex={-1}>
        Filters
      </h2>
      {tags.length > 0 && (
        <section className="sheet-section" aria-labelledby={`${id}-tags`}>
          <h3 id={`${id}-tags`}>Tags</h3>
          <ul className="chips chips-wrap" aria-labelledby={`${id}-tags`}>
            {tags.map((tag) => (
              <li key={tag}>
                <TagChip tag={tag} filters={filters} onChange={onChange} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <Choices
        label="Total Difficulty at most"
        name={`${id}-difficulty`}
        options={DIFFICULTIES}
        value={filters.maxTotalDifficulty}
        onChange={(maxTotalDifficulty) => onChange({ ...filters, maxTotalDifficulty })}
      />
      <div className="sheet-section">
        <label className="check">
          <input
            type="checkbox"
            checked={filters.easyCleanup}
            aria-describedby={`${id}-cleanup`}
            onChange={(event) => onChange({ ...filters, easyCleanup: event.target.checked })}
          />
          Easy cleanup
        </label>
        <p id={`${id}-cleanup`} className="field-hint">
          Cleanup 1 of 3
        </p>
      </div>
      <Choices
        label="Stated Time at most"
        name={`${id}-time`}
        options={TIMES}
        value={filters.maxStatedSeconds}
        onChange={(maxStatedSeconds) => onChange({ ...filters, maxStatedSeconds })}
      />
      <div className="sheet-actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => onChange(noFilters)}
        >
          Clear
        </button>
        <button
          type="button"
          className="button"
          onClick={(event) => event.currentTarget.closest("dialog")?.close()}
        >
          Done
        </button>
      </div>
    </dialog>
  );
}

// A radio group drawn as pills, for picking one maximum or Any.
function Choices({
  label,
  name,
  options,
  value,
  onChange,
}: {
  label: string;
  name: string;
  options: [number | null, string][];
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <fieldset className="sheet-section">
      <legend>{label}</legend>
      <div className="choices">
        {options.map(([option, text]) => (
          <label key={text} className="choice">
            <input
              type="radio"
              className="visually-hidden"
              name={name}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <span className="choice-text">{text}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
