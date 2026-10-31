import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Card } from "./api/client";
import { useCollection } from "./collection";
import { DifficultyMeters } from "./DifficultyMeters";
import { SearchIcon } from "./icons";
import { LoadFailed } from "./LoadFailed";
import { Plate } from "./Plate";
import { Screen } from "./Screen";
import { recipePath } from "./slug";
import { formatStatedTime } from "./statedTime";
import { TagList } from "./TagList";
import { byTitle, titleMatches } from "./titleSearch";

// The Recipes tab: every card in the Collection, by title, narrowed by a title search.
export function CollectionScreen() {
  const collection = useCollection();
  const [query, setQuery] = useState("");
  const cards = useMemo(
    () => (collection.state === "ready" ? [...collection.value.cards].sort(byTitle) : []),
    [collection],
  );
  const shown = cards.filter((card) => titleMatches(card.title, query));
  const status = useRef<HTMLParagraphElement>(null);

  return (
    <Screen title="Collection">
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
      {/* Always rendered, so screen readers hear each change: loading, then how many match. */}
      <p ref={status} role="status" tabIndex={-1} className="result-count">
        {collection.state === "loading" && "Loading the Collection…"}
        {collection.state === "ready" && resultCount(cards.length, shown.length, query)}
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

function resultCount(total: number, shown: number, query: string): string {
  if (total === 0) return "The Collection is empty.";
  if (shown === 0) return `No recipes match “${query.trim()}”.`;
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
