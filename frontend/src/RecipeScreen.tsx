import { Fragment, useEffect, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { formatAmount } from "./amount";
import type { Original, ParseFact, Recipe, RecipeFacts } from "./api/client";
import { useCollection, useRecipe } from "./collection";
import { ClockIcon } from "./icons";
import { LoadFailed } from "./LoadFailed";
import { Plate } from "./Plate";
import { byComponent } from "./recipeComponents";
import { Screen } from "./Screen";
import { recipePath, slug } from "./slug";
import { formatStatedTime, statedTimeText } from "./statedTime";
import { stepText } from "./stepText";
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
                  <Plate title={card.title} size="hero" preview={card.preview} />
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
            {
              label: "Ingredients",
              panel: <Ingredients original={recipe.value.original} facts={recipe.value.facts} />,
            },
            {
              label: "Steps",
              panel: <Steps original={recipe.value.original} facts={recipe.value.facts} />,
            },
            { label: "About", panel: <About recipe={recipe.value} /> },
          ]}
        />
      )}
    </Screen>
  );
}

// The ingredient lines under a heading wherever the Component changes. A line with a parse fact
// shows its name and preparation with the amount beside them; one without shows its raw text.
export function Ingredients({ original, facts }: { original: Original; facts?: RecipeFacts }) {
  return byComponent(original.ingredients).map((part) => (
    <section key={part.start} className="component">
      {part.component && <h2>{part.component}</h2>}
      <ul className="ingredients">
        {part.lines.map((line) => {
          const parse = facts?.ingredients[line.id]?.parse;
          return <li key={line.id}>{parse ? <ParsedLine parse={parse} /> : line.text}</li>;
        })}
      </ul>
    </section>
  ));
}

function ParsedLine({ parse }: { parse: ParseFact }) {
  const amount = parse.quantity && formatAmount(parse.quantity, parse.unit);
  // The preparation and the line's remark follow the name, as in "garlic, minced, to taste".
  const remarks = [parse.preparation, parse.comment].filter(Boolean).join(", ");
  return (
    <>
      <span className="ingredient-name">
        {parse.name}
        {remarks && <span className="ingredient-prep">, {remarks}</span>}
      </span>
      {/* The space is invisible in the flex row, but copied text reads "tahini 3 tbsp". */}
      {amount && (
        <>
          {" "}
          <span className="ingredient-amount">{amount}</span>
        </>
      )}
    </>
  );
}

// The steps, numbered through the whole recipe across its Components. Where a step names an
// ingredient line, it shows the amount that step uses, marked so it can be told apart.
export function Steps({ original, facts }: { original: Original; facts?: RecipeFacts }) {
  return byComponent(original.steps).map((part) => (
    <section key={part.start} className="component">
      {part.component && <h2>{part.component}</h2>}
      <ol className="steps" start={part.start}>
        {part.lines.map((step) => (
          <li key={step.id}>
            {stepText(step, facts, 1).map((piece, n) =>
              typeof piece === "string" ? (
                piece
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: a step's pieces never reorder.
                <Fragment key={n}>
                  <span className="step-amount">{piece.amount}</span> {piece.name}
                </Fragment>
              ),
            )}
          </li>
        ))}
      </ol>
    </section>
  ));
}

// The Stated Times (an ISO duration humanized, other text as written) and the yield as written.
export function Facts({ original }: { original: Original }) {
  const { stated_times: times, yield: recipeYield } = original;
  const time = (stated: { text: string } | null) => stated && statedTimeText(stated.text);
  const facts = [
    ["Prep", time(times.prep)],
    ["Cook", time(times.cook)],
    ["Total", time(times.total)],
    ["Yield", recipeYield?.text],
  ].filter((fact): fact is [string, string] => !!fact[1]);
  if (facts.length === 0) return null;
  return (
    <dl className="facts">
      {facts.map(([term, text]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{text}</dd>
        </div>
      ))}
    </dl>
  );
}

// The Stated Times and yield, and a link back to the Source.
function About({ recipe }: { recipe: Recipe }) {
  const { source } = recipe;
  const sourceName = source.kind === "website" ? source.site_name : source.entry_name;

  return (
    <>
      <Facts original={recipe.original} />
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
