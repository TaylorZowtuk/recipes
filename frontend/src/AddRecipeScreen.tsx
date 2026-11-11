import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  type Candidate,
  chosenDifficulty,
  type DifficultyChoice,
  type DiscardOutcome,
  discardOutcome,
  type IngestOutcome,
  ingestOutcome,
  type PasteOutcome,
  type PhotoChoice,
  parseTags,
  pasteOutcome,
  previewPhoto,
  type SaveOutcome,
  saveOutcome,
  stillStoring,
  storeCandidates,
  storedImages,
} from "./addRecipe";
import {
  api,
  type Duplicate,
  type Ingested,
  type NewRecipe,
  type QueuedIngest,
} from "./api/client";
import { forgetCollection } from "./collection";
import { useOnline } from "./online";
import { Plate } from "./Plate";
import {
  DifficultyField,
  PAUSED,
  PhotoPicker,
  TagsField,
  useEditBlock,
  useMounted,
} from "./RecipeFields";
import { Facts, Ingredients, Steps } from "./RecipeScreen";
import { focusTitle, Screen } from "./Screen";
import { EditorOnly } from "./session";
import { Tabs } from "./Tabs";

// Add a recipe from a website: paste its address, review what was captured, then save it. Keyed
// by the navigation, so it opens with a fresh form every time, even from Add a recipe itself.
// Opened from a Favorite Site, the navigation's state names it, and the address stays empty.
export function AddRecipeScreen() {
  const { key, state } = useLocation();
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
        <AddRecipe key={key} fromSite={state?.fromSite} />
      </EditorOnly>
    </Screen>
  );
}

function AddRecipe({ fromSite }: { fromSite?: string }) {
  const [pasting, setPasting] = useState<QueuedIngest>();
  const [review, setReview] = useState<Ingested>();
  const online = useOnline();
  const queued = useQueuedIngests(online);
  // One outcome at a time, the latest, shown by the form or the list, whichever it came from.
  const [outcome, setOutcome] = useState<{ from: "form" | "list"; message: Message }>();
  const say = (from: "form" | "list") => (message?: Message) =>
    setOutcome(message && { from, message });
  const shown = (from: "form" | "list") => (outcome?.from === from ? outcome.message : undefined);

  // The Queued Ingest may have gone meanwhile, so the list loads afresh.
  const backToList = () => {
    setReview(undefined);
    setPasting(undefined);
    setOutcome(undefined);
    queued.reload();
    focusTitle();
  };

  if (review) {
    return <Review ingested={review} queuedIngestId={pasting?.id} onCancel={backToList} />;
  }
  if (pasting) {
    return <PastePage item={pasting} onIngested={setReview} onBack={backToList} />;
  }
  return (
    <div className="add-recipe">
      {fromSite && (
        <p className="screen-note">
          Adding a recipe from {fromSite}. Find one at that site, then paste its address here.
        </p>
      )}
      <UrlForm
        message={shown("form")}
        onMessage={say("form")}
        onIngested={setReview}
        onQueued={queued.reload}
      />
      <QueuedIngests
        message={shown("list")}
        onMessage={say("list")}
        loaded={queued.loaded}
        online={online}
        retry={queued.reload}
        onPaste={setPasting}
        onGone={queued.drop}
      />
    </div>
  );
}

type Message = { alert: boolean; body: ReactNode };

const UNREACHABLE = "Couldn’t reach Plateful. Try again.";
const NOT_AN_EDITOR = "Only the household’s editors can add recipes. Sign in again.";
const CONFLICT = "Something changed in the meantime. Try again.";
const NOT_WAITING = "This recipe isn’t waiting any more, so someone may have finished it.";
const GONE = `${NOT_WAITING} Go back to the list, or look for it in the Collection.`;

function outcomeMessage(outcome: Exclude<IngestOutcome, { kind: "ingested" }>): Message {
  switch (outcome.kind) {
    case "queued":
      return {
        alert: false,
        body:
          outcome.queuedIngest.state === "needs_page"
            ? "This site doesn’t allow automated fetching, so the recipe needs its page pasted in. It’s in the list below."
            : "The recipe couldn’t be fetched, so it’s waiting for the fallback. It’s in the list below, where you can paste its page now.",
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
    return <>This recipe is already waiting to be added, in the list below.</>;
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
  message,
  onMessage: setMessage,
  onIngested,
  onQueued,
}: {
  message?: Message;
  onMessage: (message?: Message) => void;
  onIngested: (ingested: Ingested) => void;
  onQueued: () => void;
}) {
  const blocked = useEditBlock();
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
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

  const drop = useCallback(
    (id: string) =>
      setLoaded((list) =>
        list.state === "ready"
          ? { state: "ready", value: list.value.filter((item) => item.id !== id) }
          : list,
      ),
    [],
  );

  return { loaded, reload, drop };
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

function discardProblem(outcome: Exclude<DiscardOutcome, { kind: "discarded" }>): string {
  switch (outcome.kind) {
    case "gone":
      return `${NOT_WAITING} Look for it in the Collection.`;
    case "not-an-editor":
      return NOT_AN_EDITOR;
    case "conflict":
      return CONFLICT;
    case "failed":
      return UNREACHABLE;
  }
}

function QueuedIngests({
  message,
  onMessage: setMessage,
  loaded,
  online,
  retry,
  onPaste,
  onGone,
}: {
  message?: Message;
  onMessage: (message?: Message) => void;
  loaded: QueuedLoad;
  online: boolean;
  retry: () => void;
  onPaste: (item: QueuedIngest) => void;
  onGone: (id: string) => void;
}) {
  const blocked = useEditBlock();
  const unavailable = !online && loaded.state !== "ready";
  const [discarding, setDiscarding] = useState<string>();
  const mounted = useMounted();

  // Asks first, as deleting a recipe does. One that's gone leaves the list as a discarded one does,
  // and focus goes to the title, since the button pressed goes with it.
  const discard = async (item: QueuedIngest) => {
    const asked = `Discard ${item.source.url}? It leaves the list, and you can add it again later.`;
    if (discarding || !window.confirm(asked)) return;
    setMessage(undefined);
    setDiscarding(item.id);
    let outcome: DiscardOutcome;
    try {
      outcome = discardOutcome(
        await api.DELETE("/api/queued-ingests/{ingest_id}", {
          params: { path: { ingest_id: item.id } },
        }),
      );
    } catch {
      outcome = { kind: "failed" };
    }
    if (!mounted.current) return;
    setDiscarding(undefined);
    if (outcome.kind === "gone") forgetCollection();
    if (outcome.kind === "discarded" || outcome.kind === "gone") {
      onGone(item.id);
      focusTitle();
    }
    if (outcome.kind !== "discarded") setMessage({ alert: true, body: discardProblem(outcome) });
  };

  return (
    <section className="queued" aria-labelledby="queued-heading">
      <h2 id="queued-heading">Waiting to be added</h2>
      <p role="status" className="screen-note">
        {unavailable && "The list isn’t available offline."}
        {!unavailable && loaded.state === "loading" && "Loading…"}
        {loaded.state === "ready" && loaded.value.length === 0 && "Nothing is waiting."}
        {discarding && "Discarding…"}
      </p>
      {message && (
        <p role="alert" className="form-problem">
          {message.body}
        </p>
      )}
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
            <QueuedItem
              key={item.id}
              item={item}
              blocked={blocked}
              discarding={discarding === item.id}
              onPaste={onPaste}
              onDiscard={discard}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const sourceName = ({ source }: QueuedIngest) =>
  source.kind === "website" ? source.site_name : source.entry_name;

function SourceLink({ item }: { item: QueuedIngest }) {
  return (
    <a href={item.source.url} target="_blank" rel="noopener noreferrer" className="queued-url">
      {item.source.url}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

export function QueuedItem({
  item,
  blocked,
  discarding,
  onPaste,
  onDiscard,
}: {
  item: QueuedIngest;
  blocked: ReturnType<typeof useEditBlock>;
  discarding: boolean;
  onPaste: (item: QueuedIngest) => void;
  onDiscard: (item: QueuedIngest) => void;
}) {
  return (
    <li>
      <span className="queued-site">{sourceName(item)}</span>
      <SourceLink item={item} />
      <span className="queued-meta">
        {reasons[item.reason]} · since{" "}
        <time dateTime={item.queued_at}>{since.format(new Date(item.queued_at))}</time>
      </span>
      <span className={item.state === "needs_page" ? "badge badge-attention" : "badge"}>
        {item.state === "needs_page" ? "Needs the page pasted in" : "Waiting for the fallback"}
      </span>
      <div className="queued-actions">
        <button
          type="button"
          className="button button-secondary"
          disabled={!!blocked}
          onClick={() => onPaste(item)}
        >
          Paste its page
          <span className="visually-hidden"> for {item.source.url}</span>
        </button>
        <button
          type="button"
          className="text-button text-button-danger"
          disabled={!!blocked}
          aria-disabled={discarding}
          onClick={() => onDiscard(item)}
        >
          Discard
          <span className="visually-hidden"> for {item.source.url}</span>
        </button>
      </div>
    </li>
  );
}

function pasteProblem(outcome: Exclude<PasteOutcome, { kind: "ingested" }>): string {
  switch (outcome.kind) {
    case "no-recipe":
      return "No recipe was found in that. Copy the page’s whole source (HTML), not just the text you can see, and paste it again.";
    case "too-large":
      return "That’s too large: a page can be about 2 MB at most. Check you copied only this page’s source (HTML), and paste it again.";
    case "gone":
      return GONE;
    case "not-an-editor":
      return NOT_AN_EDITOR;
    case "conflict":
      return CONFLICT;
    case "failed":
      return UNREACHABLE;
  }
}

// Focuses the heading a step opens with, and shows the top of it.
function useOpeningHeading() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, []);
  return heading;
}

// Finishes a Queued Ingest, waiting or needing its page: the editor pastes the page's source, and what it
// captures goes to the review. The paste lives only in this component's state, and stays in the
// field through every failure. The field doesn't wrap or spell-check, so a huge paste stays quick.
export function PastePage({
  item,
  onIngested,
  onBack,
}: {
  item: QueuedIngest;
  onIngested: (ingested: Ingested) => void;
  onBack: () => void;
}) {
  const blocked = useEditBlock();
  const [html, setHtml] = useState("");
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string>();
  const mounted = useMounted();
  const heading = useOpeningHeading();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (reading) return;
    if (!html.trim()) return setProblem("Paste the page’s source (HTML) first.");
    setProblem(undefined);
    setReading(true);
    let outcome: PasteOutcome;
    try {
      outcome = pasteOutcome(
        await api.POST("/api/queued-ingests/{ingest_id}/pasted-page", {
          params: { path: { ingest_id: item.id } },
          body: { html },
        }),
      );
    } catch {
      outcome = { kind: "failed" };
    }
    if (!mounted.current) return;
    setReading(false);
    if (outcome.kind === "ingested") return onIngested(outcome.ingested);
    if (outcome.kind === "gone") forgetCollection();
    setProblem(pasteProblem(outcome));
  };

  return (
    <div className="add-recipe paste-page">
      <h2 ref={heading} tabIndex={-1}>
        Paste the page
      </h2>
      <p className="queued-site">{sourceName(item)}</p>
      <SourceLink item={item} />
      <form className="ingest-form" noValidate onSubmit={submit}>
        <fieldset disabled={!!blocked}>
          <label htmlFor="pasted-page">The page’s source (HTML)</label>
          <p id="pasted-page-hint" className="field-hint">
            Open the page in a browser, view its source, then copy all of it and paste it here.
          </p>
          <textarea
            id="pasted-page"
            className="text-input pasted-page-input"
            aria-describedby="pasted-page-hint"
            rows={8}
            wrap="off"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            value={html}
            onChange={(event) => setHtml(event.target.value)}
          />
        </fieldset>
        <div className="review-actions">
          <button type="submit" className="button" disabled={!!blocked} aria-disabled={reading}>
            {reading ? "Reading…" : "Read the page"}
          </button>
          <button type="button" className="button button-secondary" onClick={onBack}>
            Back to the list
          </button>
        </div>
        {blocked && (
          <p className="screen-note">
            {blocked === "offline"
              ? "You’re offline. Paste the page once you’re back online."
              : PAUSED}
          </p>
        )}
        <p role="status" className="screen-note">
          {reading && "Reading the page…"}
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

// Stores the Candidate Photos a couple at a time, retrying when the API is busy, so the picker
// fills in as they arrive. One that fails is unavailable and drops out.
function useCandidates(urls: string[]): Candidate[] {
  const [candidates, setCandidates] = useState<Candidate[]>(() =>
    urls.map((url) => ({ url, state: "storing" })),
  );
  useEffect(() => {
    let current = true;
    void storeCandidates(
      urls,
      (url) => api.POST("/api/images", { body: { url } }),
      (candidate) =>
        setCandidates((all) => all.map((c) => (c.url === candidate.url ? candidate : c))),
      () => !current,
    );
    return () => {
      current = false;
    };
  }, [urls]);
  return candidates;
}

// The captured Original, read-only, beside the editor's Preview Photo and optional Difficulty and
// Tags. The hero plate, and a small one beside the Focal Point picker, preview the round crop.
// With a `queuedIngestId`, saving finishes that Queued Ingest.
export function Review({
  ingested,
  queuedIngestId,
  onCancel,
}: {
  ingested: Ingested;
  queuedIngestId?: string;
  onCancel: () => void;
}) {
  const { source, original } = ingested;
  const candidates = useCandidates(ingested.candidate_photos);
  const [picked, setPicked] = useState<PhotoChoice>();
  const preview = previewPhoto(candidates, picked);
  const navigate = useNavigate();
  const blocked = useEditBlock();
  const mounted = useMounted();
  const heading = useOpeningHeading();
  const [difficulty, setDifficulty] = useState<DifficultyChoice>({});
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<ReactNode>();
  const storing = stillStoring(candidates) > 0;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    // Once nothing is storing the preview is decided; the last check only narrows its type.
    if (saving || storing || preview === undefined) return;
    const chosen = chosenDifficulty(difficulty);
    if (!chosen.complete) return setProblem("Rate all of Prep, Cook and Cleanup, or clear them.");
    setProblem(undefined);
    setSaving(true);
    const body: NewRecipe = {
      source,
      original,
      difficulty: chosen.difficulty,
      tags: parseTags(tags),
      // Every candidate that stored, picked or not, and the Preview Photo, or null for none.
      images: storedImages(candidates),
      preview,
    };
    let outcome: SaveOutcome;
    try {
      outcome = saveOutcome(
        await (queuedIngestId
          ? api.POST("/api/queued-ingests/{ingest_id}/recipe", {
              params: { path: { ingest_id: queuedIngestId } },
              body,
            })
          : api.POST("/api/recipes", { body })),
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
    if (outcome.kind === "gone" || (outcome.kind === "duplicate" && outcome.duplicate.recipe_id))
      forgetCollection();
    setProblem(
      outcome.kind === "duplicate" ? (
        <DuplicateNote duplicate={outcome.duplicate} />
      ) : outcome.kind === "gone" ? (
        GONE
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
        <Plate title={original.title} size="hero" preview={preview ?? null} />
        <p className="hero-site">{source.site_name}</p>
        <h2 ref={heading} tabIndex={-1} className="hero-title">
          {original.title}
        </h2>
        {original.author && <p className="hero-site">By {original.author}</p>}
      </header>
      <PhotoPicker
        title={original.title}
        images={storedImages(candidates)}
        storing={stillStoring(candidates)}
        preview={preview}
        onPick={setPicked}
      />
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
          <DifficultyField difficulty={difficulty} onChange={setDifficulty} />
          <TagsField tags={tags} onChange={setTags} />
        </fieldset>
        <div className="review-actions">
          <button
            type="submit"
            className="button"
            disabled={!!blocked || storing}
            aria-disabled={saving}
          >
            {saving ? "Saving…" : "Save recipe"}
          </button>
          <button type="button" className="button button-secondary" onClick={onCancel}>
            {queuedIngestId ? "Back to the list" : "Start over"}
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
          {saving ? "Saving the recipe…" : storing ? "Save waits until the photos are in." : ""}
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
