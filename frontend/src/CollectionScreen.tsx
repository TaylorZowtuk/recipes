import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Card } from "./api/client";
import {
  activeFilterCount,
  collectionTags,
  filterCards,
  isChosen,
  noFilters,
  toggleTag,
} from "./cardFilters";
import { useCollection } from "./collection";
import { DifficultyMeters } from "./DifficultyMeters";
import { FiltersSheet } from "./FiltersSheet";
import { SearchIcon } from "./icons";
import { LoadFailed } from "./LoadFailed";
import { needsReview, reviewCounts, reviewQueue } from "./needsReview";
import { Plate } from "./Plate";
import { Screen } from "./Screen";
import { useIsEditor } from "./session";
import { recipePath } from "./slug";
import { formatStatedTime } from "./statedTime";
import { TagChip, TagList } from "./TagList";
import { byTitle, titleMatches } from "./titleSearch";

// The Recipes tab: every card in the Collection, by title, narrowed by a title search, a tap on a
// Tag chip and the Filters sheet. The chips and the sheet share one set of chosen Tags. An editor's
// Needs Review chip narrows the grid further, to the cards with unchecked items in review order.
export function CollectionScreen() {
  const collection = useCollection();
  const editor = useIsEditor();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(noFilters);
  const [reviewing, setReviewing] = useState(false);
  const cards = useMemo(
    () => (collection.state === "ready" ? [...collection.value.cards].sort(byTitle) : []),
    [collection],
  );
  const tags = useMemo(() => collectionTags(cards), [cards]);
  const toReview = editor ? cards.filter(needsReview).length : 0;
  const review = editor && reviewing;
  const filtered = filterCards(cards, filters).filter((card) => titleMatches(card.title, query));
  const shown = review ? reviewQueue(filtered) : filtered;
  const active = activeFilterCount(filters) + Number(review);
  const status = useRef<HTMLParagraphElement>(null);

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
        <FiltersSheet tags={tags} filters={filters} shown={shown.length} onChange={setFilters} />
      </div>
      {/* One row of chips that scrolls sideways rather than wrapping. */}
      {/* The Needs Review chip stays while pressed, so it can be let go of after the last review. */}
      {(tags.length > 0 || toReview > 0 || review) && (
        <ul className="chips chips-row" aria-label="Filter by Tag">
          {(toReview > 0 || review) && (
            <li>
              <button
                type="button"
                className="chip chip-review"
                aria-pressed={review}
                onClick={() => setReviewing(!review)}
              >
                {`Needs Review · ${toReview}`}
              </button>
            </li>
          )}
          {tags.map((tag) => (
            <li key={tag}>
              <TagChip
                tag={tag}
                pressed={isChosen(filters, tag)}
                onToggle={() => setFilters(toggleTag(filters, tag))}
              />
            </li>
          ))}
        </ul>
      )}
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
              <RecipeCard card={card} review={review} />
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

// A card in the grid. It shows up to four Tags, so cards stay close to one height. Under Needs
// Review it also shows its Enrichment Status and how many items are flagged and to check.
export function RecipeCard({ card, review = false }: { card: Card; review?: boolean }) {
  const time = formatStatedTime(card.stated_seconds);
  return (
    <Link to={recipePath(card)} className="card">
      <Plate title={card.title} size="card" preview={card.preview} />
      <span className="card-title">{card.title}</span>
      {card.site_name && <span className="card-meta">{card.site_name}</span>}
      {time && <span className="card-meta">{time}</span>}
      <DifficultyMeters difficulty={card.difficulty} suggested={card.difficulty_suggested} />
      <TagList tags={card.tags} limit={4} />
      {card.status === "pending" && <span className="badge">Enrichment pending</span>}
      {review && card.status === "awaiting_review" && (
        <span className="badge badge-review">Awaiting Review</span>
      )}
      {review && <span className="card-review">{reviewCounts(card.needs_review)}</span>}
    </Link>
  );
}
