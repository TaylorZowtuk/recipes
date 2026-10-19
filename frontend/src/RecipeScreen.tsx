import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Card, Recipe } from "./api/client";
import { useCollection, useRecipe } from "./collection";
import { ClockIcon } from "./icons";
import { Plate } from "./Plate";
import { byComponent } from "./recipeComponents";
import { Screen } from "./Screen";
import { recipePath, slug } from "./slug";
import { formatStatedTime } from "./statedTime";
import { Tabs } from "./Tabs";

// A recipe at /recipes/<id>/<slug>. The id finds it; a stale or missing slug is corrected in place.
// The header comes from the recipe's card, so it shows as soon as the Collection has loaded.
export function RecipeScreen() {
  const { id, slug: shownSlug } = useParams();
  const navigate = useNavigate();
  const collection = useCollection();
  const card =
    collection.state === "ready" ? collection.value.cards.find((c) => c.id === id) : undefined;

  useEffect(() => {
    if (card && shownSlug !== slug(card.title)) navigate(recipePath(card), { replace: true });
  }, [card, shownSlug, navigate]);

  if (card) {
    const time = formatStatedTime(card.stated_seconds);
    return (
      <Screen
        title={card.title}
        pushed
        hero={{
          above: (
            <>
              <Plate title={card.title} size="hero" />
              {card.site_name && <p className="hero-site">{card.site_name}</p>}
            </>
          ),
          below: time && (
            <p className="hero-time">
              <ClockIcon />
              {time}
            </p>
          ),
        }}
      >
        <RecipeBody card={card} />
      </Screen>
    );
  }

  const missing = collection.state === "ready";
  return (
    <Screen title={missing ? "Recipe not found" : "Recipe"} pushed hero={{}}>
      {collection.state === "loading" && <p className="screen-note">Loading the recipe…</p>}
      {collection.state === "failed" && (
        <div className="screen-note">
          <p>The recipe couldn’t be loaded.</p>
          <button type="button" className="button" onClick={collection.retry}>
            Try again
          </button>
        </div>
      )}
      {missing && (
        <p className="screen-note">
          There’s no recipe at this address. <Link to="/recipes">Browse the Collection</Link>
        </p>
      )}
    </Screen>
  );
}

function RecipeBody({ card }: { card: Card }) {
  const recipe = useRecipe(card);
  if (recipe.state === "loading") return <p className="screen-note">Loading the recipe…</p>;
  if (recipe.state === "failed") {
    return recipe.notFound ? (
      <p className="screen-note">This recipe is no longer in the Collection.</p>
    ) : (
      <div className="screen-note">
        <p>The recipe couldn’t be loaded.</p>
        <button type="button" className="button" onClick={recipe.retry}>
          Try again
        </button>
      </div>
    );
  }
  const { value } = recipe;
  return (
    <Tabs
      label="Recipe"
      tabs={[
        { label: "Ingredients", panel: <Ingredients recipe={value} /> },
        { label: "Steps", panel: <Steps recipe={value} /> },
        { label: "About", panel: <About recipe={value} /> },
      ]}
    />
  );
}

// The ingredient lines as captured, under a heading wherever the Component changes.
function Ingredients({ recipe }: { recipe: Recipe }) {
  return byComponent(recipe.original.ingredients).map((part) => (
    <section key={part.start} className="component">
      {part.component && <h2>{part.component}</h2>}
      <ul className="ingredients">
        {part.lines.map((line) => (
          <li key={line.id}>{line.text}</li>
        ))}
      </ul>
    </section>
  ));
}

// The steps as captured, numbered through the whole recipe across its Components.
function Steps({ recipe }: { recipe: Recipe }) {
  return byComponent(recipe.original.steps).map((part) => (
    <section key={part.start} className="component">
      {part.component && <h2>{part.component}</h2>}
      <ol className="steps" start={part.start}>
        {part.lines.map((step) => (
          <li key={step.id}>{step.text}</li>
        ))}
      </ol>
    </section>
  ));
}

// The Stated Times and yield as the Source wrote them, and a link back to the Source.
function About({ recipe }: { recipe: Recipe }) {
  const { stated_times: times, yield: recipeYield } = recipe.original;
  const facts = [
    ["Prep", times.prep?.text],
    ["Cook", times.cook?.text],
    ["Total", times.total?.text],
    ["Yield", recipeYield?.text],
  ].filter((fact): fact is [string, string] => !!fact[1]);
  const { source } = recipe;
  const sourceName = source.kind === "website" ? source.site_name : source.entry_name;

  return (
    <>
      {facts.length > 0 && (
        <dl className="facts">
          {facts.map(([term, text]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="source">
        <span>Source</span>
        <a href={source.url} target="_blank" rel="noopener noreferrer">
          {sourceName}
        </a>
      </p>
    </>
  );
}
