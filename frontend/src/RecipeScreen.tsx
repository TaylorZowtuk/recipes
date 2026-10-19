import { useEffect, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Recipe } from "./api/client";
import { useCollection, useRecipe } from "./collection";
import { ClockIcon } from "./icons";
import { LoadFailed } from "./LoadFailed";
import { Plate } from "./Plate";
import { byComponent } from "./recipeComponents";
import { Screen } from "./Screen";
import { recipePath, slug } from "./slug";
import { formatStatedTime } from "./statedTime";
import { Tabs } from "./Tabs";

// A recipe at /recipes/<id>/<slug>. The id finds it; a stale or missing slug is corrected in place.
// The header comes from the recipe's card, so it shows as soon as the Collection has loaded. One
// status note stays mounted through every state, so focus can rest on it after a retry.
export function RecipeScreen() {
  const { id, slug: shownSlug } = useParams();
  const navigate = useNavigate();
  const collection = useCollection();
  const card =
    collection.state === "ready" ? collection.value.cards.find((c) => c.id === id) : undefined;
  const recipe = useRecipe(card);
  const status = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (card && shownSlug !== slug(card.title)) navigate(recipePath(card), { replace: true });
  }, [card, shownSlug, navigate]);

  const missing = collection.state === "ready" && !card;
  const loading = collection.state === "loading" || (card && recipe.state === "loading");
  const gone = card && recipe.state === "failed" && recipe.notFound;
  const failed =
    collection.state === "failed"
      ? collection
      : card && recipe.state === "failed" && !recipe.notFound
        ? recipe
        : undefined;
  const time = card && formatStatedTime(card.stated_seconds);

  return (
    <Screen
      title={card?.title ?? (missing ? "Recipe not found" : "Recipe")}
      pushed
      hero={
        card
          ? {
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
            }
          : {}
      }
    >
      <p ref={status} role="status" tabIndex={-1} className="screen-note">
        {loading && "Loading the recipe…"}
        {gone && "This recipe is no longer in the Collection."}
        {missing && "There’s no recipe at this address."}
      </p>
      {failed && <LoadFailed what="The recipe" retry={failed.retry} status={status} />}
      {missing && (
        <p className="screen-note">
          <Link to="/recipes">Browse the Collection</Link>
        </p>
      )}
      {card && recipe.state === "ready" && (
        <Tabs
          label="Recipe"
          tabs={[
            { label: "Ingredients", panel: <Ingredients recipe={recipe.value} /> },
            { label: "Steps", panel: <Steps recipe={recipe.value} /> },
            { label: "About", panel: <About recipe={recipe.value} /> },
          ]}
        />
      )}
    </Screen>
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
          <span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      </p>
    </>
  );
}
