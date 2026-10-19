import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { Card } from "./api/client";
import { useCollection } from "./collection";
import { SearchIcon } from "./icons";
import { Plate } from "./Plate";
import { Screen } from "./Screen";
import { recipePath } from "./slug";
import { formatStatedTime } from "./statedTime";
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
      {collection.state === "loading" && <p className="screen-note">Loading the Collection…</p>}
      {collection.state === "failed" && (
        <div className="screen-note">
          <p>The Collection couldn’t be loaded.</p>
          <button type="button" className="button" onClick={collection.retry}>
            Try again
          </button>
        </div>
      )}
      {collection.state === "ready" &&
        (shown.length > 0 ? (
          <ul className="card-grid" aria-label="Recipes">
            {shown.map((card) => (
              <li key={card.id}>
                <RecipeCard card={card} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="screen-note">
            {cards.length === 0
              ? "The Collection is empty."
              : `No recipes match “${query.trim()}”.`}
          </p>
        ))}
    </Screen>
  );
}

function RecipeCard({ card }: { card: Card }) {
  const time = formatStatedTime(card.stated_seconds);
  return (
    <Link to={recipePath(card)} className="card">
      <Plate title={card.title} size="card" />
      <span className="card-title">{card.title}</span>
      {card.site_name && <span className="card-meta">{card.site_name}</span>}
      {time && <span className="card-meta">{time}</span>}
      {card.status === "pending" && <span className="badge">Enrichment pending</span>}
    </Link>
  );
}
