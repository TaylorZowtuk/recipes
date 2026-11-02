import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Card } from "./api/client";
import { activeFilterCount, collectionTags, filterCards, noFilters } from "./cardFilters";
import { useCollection } from "./collection";
import { DifficultyMeters } from "./DifficultyMeters";
import { FiltersSheet, TagChip } from "./FiltersSheet";
import { SearchIcon } from "./icons";
import { LoadFailed } from "./LoadFailed";
import { Plate } from "./Plate";
import { Screen } from "./Screen";
import { recipePath } from "./slug";
import { formatStatedTime } from "./statedTime";
import { TagList } from "./TagList";
import { byTitle, titleMatches } from "./titleSearch";

// The Recipes tab: every card in the Collection, by title, narrowed by a title search, a tap on a
// Tag chip and the Filters sheet. The chips and the sheet share one set of chosen Tags.
export function CollectionScreen() {
  const collection = useCollection();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(noFilters);
  const cards = useMemo(
    () => (collection.state === "ready" ? [...collection.value.cards].sort(byTitle) : []),
    [collection],
  );
  const tags = useMemo(() => collectionTags(cards), [cards]);
  const shown = filterCards(cards, filters).filter((card) => titleMatches(card.title, query));
  const active = activeFilterCount(filters);
  const status = useRef<HTMLParagraphElement>(null);
  const sheet = useRef<HTMLDialogElement>(null);
  const filtersButton = useRef<HTMLButtonElement>(null);

  return (
    <Screen title="Collection">
      <div className="search-row">
        <search className="search">
          <SearchIcon />
          <input
            type="search"
            aria-label="Search recipe titles"
            placeholder="Search recipes"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </search>
        <button
          ref={filtersButton}
          type="button"
          className="button button-secondary"
          aria-haspopup="dialog"
          onClick={() => {
            sheet.current?.showModal();
            sheet.current?.querySelector("h2")?.focus();
          }}
        >
          {active > 0 ? `Filters · ${active}` : "Filters"}
        </button>
      </div>
      {/* One row of chips that scrolls sideways rather than wrapping. */}
      {tags.length > 0 && (
        <ul className="chips chips-row" aria-label="Filter by Tag">
          {tags.map((tag) => (
            <li key={tag}>
              <TagChip tag={tag} filters={filters} onChange={setFilters} />
            </li>
          ))}
        </ul>
      )}
      <FiltersSheet
        ref={sheet}
        tags={tags}
        filters={filters}
        shown={shown.length}
        onChange={setFilters}
        onClose={() => filtersButton.current?.focus()}
      />
      {/* Always rendered, so screen readers hear each change: loading, then how many match. */}
      <p ref={status} role="status" tabIndex={-1} className="result-count">
        {collection.state === "loading" && "Loading the Collection…"}
        {collection.state === "ready" && resultCount(cards.length, shown.length, query, active > 0)}
      </p>
      {collection.state === "failed" && (
        <LoadFailed what="The Collection" retry={collection.retry} status={status} />
      )}
      {shown.length > 0 && (
        <ul className="card-grid" aria-label="Recipes">
          {shown.map((card) => (
            <li key={card.id}>
              <RecipeCard card={card} />
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}

function resultCount(total: number, shown: number, query: string, filtering: boolean): string {
  const q = query.trim();
  if (total === 0) return "The Collection is empty.";
  if (shown === 0 && filtering) {
    return q ? `No recipes match “${q}” and these filters.` : "No recipes match these filters.";
  }
  if (shown === 0) return `No recipes match “${q}”.`;
  return shown === 1 ? "1 recipe" : `${shown} recipes`;
}

// A card in the grid. It shows up to four Tags, so cards stay close to one height.
export function RecipeCard({ card }: { card: Card }) {
  const time = formatStatedTime(card.stated_seconds);
  return (
    <Link to={recipePath(card)} className="card">
      <Plate title={card.title} size="card" preview={card.preview} />
      <span className="card-title">{card.title}</span>
      {card.site_name && <span className="card-meta">{card.site_name}</span>}
      {time && <span className="card-meta">{time}</span>}
      <DifficultyMeters difficulty={card.difficulty} />
      <TagList tags={card.tags} limit={4} />
      {card.status === "pending" && <span className="badge">Enrichment pending</span>}
    </Link>
  );
}
