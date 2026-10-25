# Candidate Photos are stored by their own endpoint before save, and crops are computed at display

Photos don't share ingest's request. `POST /api/ingest` only finds the Candidate Photos, and the Add a recipe review screen stores each one with its own editor-only call, `POST /api/images {url}`, made in parallel. This supersedes one line of the [website ingest ADR](2026-10-24-website-ingest.md): at the preview step **nothing but photos is stored**. It fills in the images the [recipe data model ADR](2026-09-29-recipe-data-model.md) already describes (`images [{id (content hash), width, height, origin}]`, `preview {image_id, focal_x, focal_y}`) and leaves the [offline cache and sync ADR](2026-10-01-offline-cache-and-sync.md)'s caching unchanged.

We chose a separate endpoint because ingest's page fetch can already take about 22 s of the 30 s CloudFront and Lambda limit, which leaves no room for photos in the same request. One request per photo gives each its own budget, and the requests run side by side. We chose to store before save so that the photo picker and the live round-crop preview show the stored copy exactly as cards will, rather than the Source's own image.

## The flow

1. `POST /api/ingest {url}` returns the captured Original, the website Source and the **Candidate Photo** URLs it found: the schema.org Recipe `image` and the page's `og:image`, resolved against the final URL, deduped and capped. It still stores no recipe data.
2. The review screen calls `POST /api/images {url}` once per candidate, in parallel. Each call returns the stored image's `{id, width, height}`, or an error that drops that candidate from the picker. Nothing else depends on it.
3. The editor picks the **Preview Photo**, or none, and drags its **Focal Point** with a live round-crop preview.
4. `POST /api/recipes` takes `images[]` and `preview {image_id, focal_x, focal_y}` beside the rest. It checks they're well formed (the preview names one of `images`, and the focal point's fractions are between 0 and 1) and that each image's objects exist in the bucket. Then it saves as before.

## Storing an image

- **Fetch:** the same fetch policy as ingest: the honest user agent, robots.txt, public addresses only, redirects followed by hand, a deadline and a body size cap. The image must also be under a pixel-count limit, checked before it's decoded, so a small file that decodes to a huge image can't exhaust the Lambda's memory.
- **Key:** the content hash of the source bytes. The image is stored once as WebP at `images/<hash>.webp`, at most 1600 px on its long side, with a card-size copy about 400 px wide at `images/<hash>-card.webp`.
- **Dedupe:** if the object already exists, the upload is skipped. The same photo found on two Sources, or offered again on a re-ingest, is stored once.
- **Cache headers:** immutable, since a key's content never changes.

## Display

Crops are **computed at display, never stored**. Cards and the recipe header draw the Preview Photo in a round plate with CSS `object-position` set from the Focal Point, so changing the Focal Point rewrites two numbers and no image. A recipe with no Preview Photo shows the **Empty Plate**.

Candidate Photos the editor didn't pick are kept in the recipe's `images`, so an editor can choose a different one later, but phones never prefetch them, as the offline cache and sync ADR already says.

## Consequences

- A recipe the editor abandons leaves its stored Candidate Photos in the bucket, unreferenced: a few objects of a few hundred KB each. They're harmless and immutable, and we accept them. There is no cleanup job. If they ever add up, one could list the keys no recipe references and delete them.
- The review screen fills in its photos as they arrive, rather than all at once with the Original.
- Save fetches nothing, so a slow image host can't stall it: every photo it references is already stored.

## Considered options

- **Store the photos during ingest:** rejected. They would share the 30 s budget with a page fetch that can take 22 s of it, so a slow site would lose its photos.
- **Download the photos at save:** rejected, though it would keep "nothing is stored before save". One slow image host would stall or fail the save, the downloads would run one after another in one request, and the picker would show the Source's hotlinked image rather than the stored copy.
- **Store each crop:** rejected. A crop is a function of the image and two numbers, and storing it would mean a new object every time the Focal Point moved.
