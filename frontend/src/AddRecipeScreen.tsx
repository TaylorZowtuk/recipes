import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  chosenDifficulty,
  type DifficultyChoice,
  editBlock,
  type IngestOutcome,
  ingestOutcome,
  parseTags,
  type SaveOutcome,
  saveOutcome,
} from "./addRecipe";
import {
  api,
  type Difficulty,
  type Duplicate,
  type Ingested,
  type QueuedIngest,
} from "./api/client";
import { forgetCollection, useSync } from "./collection";
import { useOnline } from "./online";
import { Plate } from "./Plate";
import { Facts, Ingredients, Steps } from "./RecipeScreen";
import { focusTitle, Screen } from "./Screen";
import { EditorOnly } from "./session";
import { Tabs } from "./Tabs";

// Add a recipe from a website: paste its address, review what was captured, then save it. Keyed
// by the navigation, so it opens with a fresh form every time, even from Add a recipe itself.
export function AddRecipeScreen() {
  const { key } = useLocation();
  return (
    <Screen title="Add a recipe" pushed>
      <EditorOnly
        fallback={
          <div className="prompt">
            <p>Only the household’s editors can add recipes.</p>
            <Link to="/sign-in" className="button">
              Sign in
            </Link>
          </div>
        }
      >
        <AddRecipe key={key} />
      </EditorOnly>
    </Screen>
  );
}

// Why editing is off, if it is: offline, or paused while the API is read-only.
function useEditBlock() {
  return editBlock(useOnline(), useSync());
}

function AddRecipe() {
  const [review, setReview] = useState<Ingested>();
  const online = useOnline();
  const queued = useQueuedIngests(online);

  if (review) {
    return (
      <Review
        ingested={review}
        onCancel={() => {
          setReview(undefined);
          focusTitle();
        }}
      />
    );
  }
  return (
    <div className="add-recipe">
      <UrlForm onIngested={setReview} onQueued={queued.reload} />
      <QueuedIngests loaded={queued.loaded} online={online} retry={queued.reload} />
    </div>
  );
}

type Message = { alert: boolean; body: ReactNode };

const UNREACHABLE = "Couldn’t reach Plateful. Try again.";
const NOT_AN_EDITOR = "Only the household’s editors can add recipes. Sign in again.";
const CONFLICT = "Something changed while saving. Try again.";
const PAUSED = "Editing is paused while Plateful updates.";

function outcomeMessage(outcome: Exclude<IngestOutcome, { kind: "ingested" }>): Message {
  switch (outcome.kind) {
    case "queued":
      return {
        alert: false,
        body:
          outcome.queuedIngest.state === "needs_page"
            ? "This site doesn’t allow automated fetching, so the recipe needs its page pasted in later. It’s in the list below."
            : "The recipe couldn’t be fetched, so it’s waiting for the fallback. It’s in the list below.",
      };
    case "duplicate":
      return { alert: false, body: <DuplicateNote duplicate={outcome.duplicate} /> };
    case "not-found":
      return { alert: true, body: "That page isn’t on the site. Check the address and try again." };
    case "invalid":
      return {
        alert: true,
        body: "That isn’t a web address. Paste one that starts with https://.",
      };
    case "not-an-editor":
      return { alert: true, body: NOT_AN_EDITOR };
    case "conflict":
      return { alert: true, body: CONFLICT };
    case "failed":
      return { alert: true, body: UNREACHABLE };
  }
}

// What a duplicate Source already is: a recipe, with a link to it, or a Queued Ingest.
function DuplicateNote({ duplicate }: { duplicate: Duplicate }) {
  if (duplicate.queued_ingest_id) {
    return <>This recipe is already waiting for the fallback, in the list below.</>;
  }
  return (
    <>
      This recipe is already in the Collection.
      {duplicate.recipe_id && (
        <>
          {" "}
          <Link to={`/recipes/${duplicate.recipe_id}`}>Open it</Link>
        </>
      )}
    </>
  );
}

// The web address form. Off while offline or paused: adding a recipe is never queued.
function UrlForm({
  onIngested,
  onQueued,
}: {
  onIngested: (ingested: Ingested) => void;
  onQueued: () => void;
}) {
  const blocked = useEditBlock();
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [message, setMessage] = useState<Message>();
  const mounted = useMounted();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (fetching) return;
    if (!url.trim()) return setMessage(outcomeMessage({ kind: "invalid" }));
    setMessage(undefined);
    setFetching(true);
    let outcome: IngestOutcome;
    try {
      outcome = ingestOutcome(await api.POST("/api/ingest", { body: { url: url.trim() } }));
    } catch {
      outcome = { kind: "failed" };
    }
    if (!mounted.current) return;
    setFetching(false);
    if (outcome.kind === "ingested") return onIngested(outcome.ingested);
    setMessage(outcomeMessage(outcome));
    if (outcome.kind === "queued" || outcome.kind === "duplicate") {
      setUrl("");
      if (outcome.kind === "queued") onQueued();
      // The recipe may be newer than this page load's Collection, so its link loads it afresh.
      else if (outcome.duplicate.recipe_id) forgetCollection();
    }
  };

  return (
    <form className="ingest-form" noValidate onSubmit={submit}>
      <fieldset disabled={!!blocked}>
        <label htmlFor="recipe-url">Recipe web address</label>
        <div className="ingest-row">
          <input
            id="recipe-url"
            className="text-input"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="https://"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button type="submit" className="button" aria-disabled={fetching}>
            {fetching ? "Fetching…" : "Fetch"}
          </button>
        </div>
      </fieldset>
      {blocked && (
        <p className="screen-note">
          {blocked === "offline" ? "You’re offline. Add a recipe once you’re back online." : PAUSED}
        </p>
      )}
      <p role="status" className="screen-note">
        {fetching ? "Fetching the recipe…" : message && !message.alert && message.body}
      </p>
      {message?.alert && (
        <p role="alert" className="form-problem">
          {message.body}
        </p>
      )}
    </form>
  );
}

function useMounted() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

type QueuedLoad =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; value: QueuedIngest[] };

// The Queued Ingests, oldest first. A reload keeps the list on screen until the new one arrives.
// Offline it waits, and loads once the network is back.
function useQueuedIngests(online: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<QueuedLoad>({ state: "loading" });
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs it on a reload.
  useEffect(() => {
    if (!online) return;
    let current = true;
    api.GET("/api/queued-ingests").then(
      ({ data }) =>
        current && setLoaded(data ? { state: "ready", value: data } : { state: "failed" }),
      () => current && setLoaded({ state: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [attempt, online]);

  return { loaded, reload };
}

const reasons: Record<QueuedIngest["reason"], string> = {
  robots: "The site doesn’t allow automated fetching",
  blocked: "The site turned the request away",
  rate_limited: "The site asked for fewer requests",
  server_error: "The site had an error",
  unreachable: "The site couldn’t be reached",
  no_recipe: "No recipe was found on the page",
};

const since = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function QueuedIngests({
  loaded,
  online,
  retry,
}: {
  loaded: QueuedLoad;
  online: boolean;
  retry: () => void;
}) {
  const unavailable = !online && loaded.state !== "ready";
  return (
    <section className="queued" aria-labelledby="queued-heading">
      <h2 id="queued-heading">Waiting for the fallback</h2>
      <p role="status" className="screen-note">
        {unavailable && "The list isn’t available offline."}
        {!unavailable && loaded.state === "loading" && "Loading…"}
        {loaded.state === "ready" && loaded.value.length === 0 && "Nothing is waiting."}
      </p>
      {!unavailable && loaded.state === "failed" && (
        <div className="screen-note">
          <p role="alert">The list couldn’t be loaded.</p>
          <button type="button" className="button" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {loaded.state === "ready" && loaded.value.length > 0 && (
        <ul className="queued-list" aria-labelledby="queued-heading">
          {loaded.value.map((item) => (
            <QueuedItem key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function QueuedItem({ item }: { item: QueuedIngest }) {
  const { source } = item;
  const name = source.kind === "website" ? source.site_name : source.entry_name;
  return (
    <li>
      <span className="queued-site">{name}</span>
      <a href={source.url} target="_blank" rel="noopener noreferrer" className="queued-url">
        {source.url}
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
      <span className="queued-meta">
        {reasons[item.reason]} · since{" "}
        <time dateTime={item.queued_at}>{since.format(new Date(item.queued_at))}</time>
      </span>
      <span className={item.state === "needs_page" ? "badge badge-attention" : "badge"}>
        {item.state === "needs_page" ? "Needs the page pasted in" : "Waiting for the fallback"}
      </span>
    </li>
  );
}

const PARTS = [
  ["prep", "Prep"],
  ["cook", "Cook"],
  ["cleanup", "Cleanup"],
] as const satisfies [keyof Difficulty, string][];

// The captured Original, read-only, beside the editor's optional Difficulty and Tags.
function Review({ ingested, onCancel }: { ingested: Ingested; onCancel: () => void }) {
  const { source, original } = ingested;
  const navigate = useNavigate();
  const blocked = useEditBlock();
  const mounted = useMounted();
  const heading = useRef<HTMLHeadingElement>(null);
  const [difficulty, setDifficulty] = useState<DifficultyChoice>({});
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<ReactNode>();

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const chosen = chosenDifficulty(difficulty);
    if (!chosen.complete) return setProblem("Rate all of Prep, Cook and Cleanup, or clear them.");
    setProblem(undefined);
    setSaving(true);
    let outcome: SaveOutcome;
    try {
      outcome = saveOutcome(
        await api.POST("/api/recipes", {
          body: { source, original, difficulty: chosen.difficulty, tags: parseTags(tags) },
        }),
      );
    } catch {
      // Offline or unreachable: the problem below says to try again.
      outcome = { kind: "failed" };
    }
    if (!mounted.current) return;
    setSaving(false);
    if (outcome.kind === "saved") {
      forgetCollection();
      return navigate("/recipes");
    }
    if (outcome.kind === "duplicate" && outcome.duplicate.recipe_id) forgetCollection();
    setProblem(
      outcome.kind === "duplicate" ? (
        <DuplicateNote duplicate={outcome.duplicate} />
      ) : outcome.kind === "not-an-editor" ? (
        NOT_AN_EDITOR
      ) : outcome.kind === "conflict" ? (
        CONFLICT
      ) : (
        "The recipe couldn’t be saved. Try again."
      ),
    );
  };

  return (
    <div className="add-recipe review">
      <header className="hero">
        <Plate title={original.title} size="hero" />
        <p className="hero-site">{source.site_name}</p>
        <h2 ref={heading} tabIndex={-1} className="hero-title">
          {original.title}
        </h2>
        {original.author && <p className="hero-site">By {original.author}</p>}
      </header>
      {original.description && <p className="review-description">{original.description}</p>}
      <Facts original={original} />
      <Tabs
        label="Captured recipe"
        tabs={[
          { label: "Ingredients", panel: <Ingredients original={original} /> },
          { label: "Steps", panel: <Steps original={original} /> },
        ]}
      />
      <form className="review-form" noValidate onSubmit={save}>
        <fieldset disabled={!!blocked} className="review-fields">
          <fieldset className="difficulty">
            <legend>Difficulty</legend>
            <p className="field-hint">Optional. 1 is easy, 3 is hard.</p>
            {PARTS.map(([part, label]) => (
              <fieldset key={part} className="rating">
                <legend>{label}</legend>
                <div className="segments">
                  {[1, 2, 3].map((n) => (
                    <label key={n}>
                      <input
                        type="radio"
                        className="visually-hidden"
                        name={`difficulty-${part}`}
                        checked={difficulty[part] === n}
                        onChange={() => setDifficulty((d) => ({ ...d, [part]: n }))}
                      />
                      <span>{n}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
            {Object.keys(difficulty).length > 0 && (
              <button type="button" className="text-button" onClick={() => setDifficulty({})}>
                Clear Difficulty
              </button>
            )}
          </fieldset>
          <label htmlFor="recipe-tags">Tags</label>
          <p id="recipe-tags-hint" className="field-hint">
            Optional. Separate tags with commas.
          </p>
          <input
            id="recipe-tags"
            className="text-input"
            aria-describedby="recipe-tags-hint"
            autoComplete="off"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
          />
        </fieldset>
        <div className="review-actions">
          <button type="submit" className="button" disabled={!!blocked} aria-disabled={saving}>
            {saving ? "Saving…" : "Save recipe"}
          </button>
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Start over
          </button>
        </div>
        {blocked && (
          <p className="screen-note">
            {blocked === "offline"
              ? "You’re offline. Save the recipe once you’re back online."
              : PAUSED}
          </p>
        )}
        <p role="status" className="screen-note">
          {saving ? "Saving the recipe…" : ""}
        </p>
        {problem && (
          <p role="alert" className="form-problem">
            {problem}
          </p>
        )}
      </form>
    </div>
  );
}
