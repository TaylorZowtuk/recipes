"""The enrich CLI hands a model a Work Packet of every Pending recipe, then checks the model's
answer against what the packet offered and writes the facts through the API.
"""

import hashlib
import io
import json
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
from conftest import SERVICE_TOKEN
from requests.adapters import BaseAdapter
from requests.models import PreparedRequest, Response
from requests.structures import CaseInsensitiveDict
from test_enrichment_review import FACTS, LLM, SWAP
from test_our_version_enrichment import pending as our_version_pending

from recipes import fdc
from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.client import SameOriginSession, Send, checked_base_url, send_with
from recipes.enrich import (
    Chosen,
    apply,
    ask,
    main,
    packet,
    read_answer,
    read_substitutes,
    stale,
)
from recipes.models import (
    MAX_LABEL,
    SCHEMA_VERSION,
    CanonicalIngredient,
    IngestChannel,
    IngredientFacts,
    IngredientLine,
    Original,
    Recipe,
    Step,
    StepFacts,
    SubstitutionsFact,
    UsesFact,
    WebsiteSource,
    Wording,
    effective,
    new_ulid,
)
from recipes.packet import ENRICHMENT_VERSION
from recipes.substitutes import Substitutes

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient

    from recipes.store import Store

BASE_URL = "http://testserver"
SNAPSHOT = fdc.load_snapshot(Path(__file__).parent / "fixtures" / "fdc-snapshot.json")
# Answers a request with its status, headers and body.
type Handler = Callable[[PreparedRequest], tuple[int, dict[str, str], bytes]]


class Adapter(BaseAdapter):
    """Answers the CLI's requests with `handle` in place of the network, keeping each one."""

    def __init__(self, handle: Handler) -> None:
        super().__init__()
        self.handle = handle
        self.requests: list[PreparedRequest] = []

    def send(self, request: PreparedRequest, *_args: Any, **_kwargs: Any) -> Response:
        self.requests.append(request)
        status, headers, body = self.handle(request)
        response = Response()
        response.status_code = status
        response.headers = CaseInsensitiveDict(headers)
        response.raw = io.BytesIO(body)
        response.url = request.url or ""
        response.request = request
        return response

    def close(self) -> None:
        pass


def through(adapter: Adapter) -> Send:
    """The CLI's own transport, sending through `adapter`."""
    session = SameOriginSession()
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return send_with(session, SERVICE_TOKEN)


def api(client: TestClient) -> Adapter:
    """Sends each request to the in-process API."""

    def handle(request: PreparedRequest) -> tuple[int, dict[str, str], bytes]:
        body = request.body.encode() if isinstance(request.body, str) else request.body
        response = client.request(
            request.method or "GET", request.url or "", headers=request.headers, content=body
        )
        return response.status_code, dict(response.headers), response.content

    return Adapter(handle)


def add(
    store: Store,
    title: str,
    status: str = "pending",
    channel: IngestChannel | None = "add_a_recipe",
    lines: list[IngredientLine] | None = None,
) -> Recipe:
    slug = title.lower().replace(" ", "-")
    lines = lines or [
        IngredientLine(id="i1", component="For the marinade", text="2 tbsp glimmer oil"),
        IngredientLine(id="i2", component="For the marinade", text="3 cloves snorp garlic, minced"),
        IngredientLine(id="i3", component="For the sauce", text="1-2 quill eggs, or to taste"),
        IngredientLine(id="i4", component="For the sauce", text="salt, to taste"),
    ]
    recipe = Recipe(
        id=new_ulid(),
        schema_version=SCHEMA_VERSION,
        version=1,
        source=WebsiteSource(
            url=f"https://example.com/{slug}",
            site_name="Example Kitchen",
            captured_at="2026-09-01T12:00:00Z",  # pyright: ignore[reportArgumentType]
        ),
        dedupe_key=f"https://example.com/{slug}",
        original=Original(title=title, extractor="json-ld", ingredients=lines, steps=[]),
        status=status,  # pyright: ignore[reportArgumentType]
        ingest_channel=channel,
    )
    return store.add_recipe(recipe)


def stored(client: TestClient, recipe_id: str) -> dict[str, Any]:
    return client.get(f"/api/recipes/{recipe_id}", follow_redirects=True).json()


def bundle(client: TestClient) -> dict[str, Any]:
    return client.get("/api/collection", follow_redirects=True).json()


def work_packet(send: Send, capsys: pytest.CaptureFixture[str]) -> dict[str, Any]:
    """The packet `enrich packet` prints."""
    assert packet(BASE_URL, send, SNAPSHOT) == 0
    return json.loads(capsys.readouterr().out)


NEW_GLIMMER = {"new": {"name": "glimmer oil", "family": "oil", "store_category_id": "aisles"}}


def oil_line(**fields: Any) -> dict[str, Any]:
    """An answer for "2 tbsp glimmer oil" within the offers: a new canonical, its food and tbsp."""
    return {
        "line_id": "i1",
        "canonical": NEW_GLIMMER,
        "fdc_id": 2004,
        "portion_id": 606,
        **fields,
    }


def answer_text(offered: dict[str, Any], *lines: dict[str, Any]) -> str:
    """A model's answer to the packet: `lines` for every recipe in it."""
    return json.dumps(
        {
            "model": "a-model",
            "recipes": [
                {
                    "recipe_id": r["recipe_id"],
                    "offer_id": r["offer_id"],
                    "lines": list(lines or [oil_line()]),
                }
                for r in offered["recipes"]
            ],
        }
    )


def test_packet_prints_every_pending_recipe_and_writes_nothing(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    pending = add(api_store, "Garlic Tofu")
    add(api_store, "Ready Stew", status="ready")
    adapter = api(editor_client)
    before = bundle(editor_client)

    offered = work_packet(through(adapter), capsys)

    assert {request.method for request in adapter.requests} == {"GET"}
    assert bundle(editor_client) == before
    assert offered["fdc_release"] == SNAPSHOT.release
    assert [r["recipe_id"] for r in offered["recipes"]] == [pending.id]
    lines = offered["recipes"][0]["lines"]
    assert [ln["line_id"] for ln in lines] == ["i1", "i2", "i3", "i4"]
    assert lines[2]["parse"]["quantity"] == {"low": 1, "high": 2}
    assert lines[2]["readable_quantities"] == [1, 2]
    assert [food["fdc_id"] for food in lines[0]["fdc_candidates"]] == [2004]
    assert [c["id"] for c in offered["store_categories"]][:3] == ["household", "produce", "meat"]


def test_apply_writes_each_answered_lines_match_and_conversion_and_learns_its_wording(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe = add(api_store, "Garlic Tofu")
    send = through(api(editor_client))
    offered = work_packet(send, capsys)

    failed = apply(BASE_URL, send, SNAPSHOT, answer_text(offered))

    assert failed == 0
    assert "Garlic Tofu → awaiting_review" in capsys.readouterr().out
    enriched = stored(editor_client, recipe.id)
    assert enriched["enrichment_version"] == ENRICHMENT_VERSION == 4
    assert enriched["fdc_release"] == SNAPSHOT.release
    facts = enriched["facts"]["ingredients"]
    assert sorted(facts) == ["i1", "i2", "i3", "i4"]
    chili = facts["i3"]["parse"]
    assert (chili["quantity"], chili["name"], chili["comment"]) == (
        {"low": 1, "high": 2},
        "quill eggs",
        "or to taste",
    )
    assert facts["i2"]["match"] is None
    (created,) = bundle(editor_client)["canonical_ingredients"]
    assert (created["name"], created["family"], created["store_category_id"]) == (
        "glimmer oil",
        "oil",
        "aisles",
    )
    oil = facts["i1"]
    assert oil["match"]["provenance"] == "llm"
    assert (oil["match"]["canonical_id"], oil["match"]["fdc_id"]) == (created["id"], 2004)
    assert oil["conversion"]["provenance"] == "fdc"
    assert oil["conversion"]["density_g_per_ml"] == pytest.approx(13.5 / 14.78676478125)
    assert oil["conversion"]["per_100g"]["kcal"] == 884
    assert [
        (w["wording"], w["canonical_id"], w["confirmed"]) for w in bundle(editor_client)["wordings"]
    ] == [("glimmer oil", created["id"], False)]
    (issue,) = enriched["issues"]
    assert issue["reason"] == "new Canonical Ingredient glimmer oil (oil, Aisles)"


ZORBLEBERRY_OIL = "Zorbleberry oil works in place of the glimmer oil."


def substituting(api_store: Store) -> tuple[Recipe, CanonicalIngredient]:
    """A Pending recipe whose description states a substitute for its glimmer oil, and the
    zorbleberry Canonical Ingredient another recipe made.
    """
    zorbleberry = CanonicalIngredient(
        id=new_ulid(),
        name="zorbleberry",
        family="berry",
        store_category_id="produce",
        version=1,
        schema_version=SCHEMA_VERSION,
    )
    api_store.enrich_recipe(add(api_store, "Ready Stew", status="ready"), [zorbleberry], [])
    recipe = add(api_store, "Garlic Tofu")
    original = recipe.original.model_copy(update={"description": ZORBLEBERRY_OIL})
    return api_store.update_recipe(recipe.model_copy(update={"original": original})), zorbleberry


def quoting(recipe_id: str, *wordings: str) -> Substitutes:
    """A substitutes file quoting each wording for line i1 from the description."""
    quoted = [{"wording": wording, "quoted_from": "description"} for wording in wordings]
    return Substitutes.model_validate(
        {"recipes": [{"recipe_id": recipe_id, "lines": [{"line_id": "i1", "substitutes": quoted}]}]}
    )


def substituted_answer(offered: dict[str, Any], canonical_id: str) -> str:
    answered = json.loads(
        answer_text(
            offered,
            oil_line(
                substitutions=[
                    {
                        "wording": "zorbleberry oil",
                        "canonical_id": canonical_id,
                        "fdc_id": 1001,
                        "portion_id": 501,
                        "ratio": 1.5,
                        "note": "fruitier",
                    }
                ]
            ),
        )
    )
    answered["recipes"][0]["difficulty"] = {"prep": 1, "cook": 2, "cleanup": 1}
    return json.dumps(answered)


def test_substitutes_then_packet_then_apply_writes_substitutions_and_difficulty(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe, zorbleberry = substituting(api_store)
    adapter = api(editor_client)
    send = through(adapter)

    assert ask(BASE_URL, send) == 0
    (asked,) = json.loads(capsys.readouterr().out)["recipes"]
    assert (asked["recipe_id"], asked["description"]) == (recipe.id, ZORBLEBERRY_OIL)
    quoted = quoting(recipe.id, "zorbleberry oil")
    assert packet(BASE_URL, send, SNAPSHOT, quoted) == 0
    offered = json.loads(capsys.readouterr().out)
    (offer,) = offered["recipes"][0]["lines"][0]["substitute_offers"]
    assert [c["id"] for c in offer["canonical_candidates"]] == [zorbleberry.id]

    failed = apply(BASE_URL, send, SNAPSHOT, substituted_answer(offered, zorbleberry.id), quoted)

    assert failed == 0
    assert {request.method for request in adapter.requests} == {"GET", "PUT"}
    facts = stored(editor_client, recipe.id)["facts"]
    fact = facts["ingredients"]["i1"]["substitutions"]
    assert (fact["provenance"], fact["estimated"], fact["confirmed"]) == ("llm", True, False)
    (item,) = fact["items"]
    assert (item["wording"], item["canonical_id"], item["ratio"]) == (
        "zorbleberry oil",
        zorbleberry.id,
        1.5,
    )
    assert item["fdc"]["per_100g"] == SNAPSHOT.food(1001).per_100g.model_dump()
    difficulty = facts["difficulty"]
    assert (difficulty["prep"], difficulty["cook"], difficulty["cleanup"]) == (1, 2, 1)
    assert (difficulty["provenance"], difficulty["confirmed"]) == ("llm", False)


@pytest.mark.parametrize("later", [None, "Zorbleberry oil"], ids=["none", "another"])
def test_an_answer_applied_with_other_substitutes_than_its_packet_is_rejected(
    editor_client: TestClient,
    api_store: Store,
    capsys: pytest.CaptureFixture[str],
    later: str | None,
) -> None:
    recipe, zorbleberry = substituting(api_store)
    send = through(api(editor_client))
    assert packet(BASE_URL, send, SNAPSHOT, quoting(recipe.id, "zorbleberry oil")) == 0
    offered = json.loads(capsys.readouterr().out)
    stale = quoting(recipe.id, later) if later else None

    failed = apply(BASE_URL, send, SNAPSHOT, substituted_answer(offered, zorbleberry.id), stale)

    assert failed == 1
    assert "Garlic Tofu → rejected, nothing written:\n  its offer changed since the packet" in (
        capsys.readouterr().out
    )
    assert stored(editor_client, recipe.id)["status"] == "pending"


def test_rerunning_apply_after_a_partial_success_writes_the_rest(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    first, zorbleberry = substituting(api_store)
    # The glimmer oil exists and its wording is cached, so writing one recipe changes no offer.
    glimmer = zorbleberry.model_copy(
        update={"id": new_ulid(), "name": "glimmer oil", "family": "oil"}
    )
    cached = Wording(wording="glimmer oil", canonical_id=glimmer.id, schema_version=SCHEMA_VERSION)
    api_store.enrich_recipe(add(api_store, "Ready Soup", status="ready"), [glimmer], [cached])
    second = add(api_store, "Chili Noodles")
    original = second.original.model_copy(update={"description": ZORBLEBERRY_OIL})
    second = api_store.update_recipe(second.model_copy(update={"original": original}))
    quoted = Substitutes.model_validate(
        {
            "recipes": [
                quoting(recipe.id, "zorbleberry oil").recipes[0].model_dump()
                for recipe in (first, second)
            ]
        }
    )
    send = through(api(editor_client))
    assert packet(BASE_URL, send, SNAPSHOT, quoted) == 0
    offered = json.loads(capsys.readouterr().out)
    answered = json.loads(substituted_answer(offered, zorbleberry.id))
    for recipe in answered["recipes"]:
        recipe["lines"][0]["canonical"] = {"id": glimmer.id}
    text = json.dumps(answered)

    def second_unavailable(method: str, url: str, body: bytes | None) -> tuple[int, Any]:
        if method == "PUT" and second.id in url:
            return 503, "unavailable"
        return send(method, url, body)

    assert apply(BASE_URL, second_unavailable, SNAPSHOT, text, quoted) == 1
    assert stored(editor_client, first.id)["status"] == "awaiting_review"
    capsys.readouterr()

    failed = apply(BASE_URL, send, SNAPSHOT, text, quoted)

    printed = capsys.readouterr()
    assert f"{first.id} isn't one of the recipes to enrich" in printed.err
    assert "Chili Noodles → awaiting_review" in printed.out
    assert failed == 1  # the first recipe, which isn't in the packet any more
    assert stored(editor_client, second.id)["facts"]["ingredients"]["i1"]["substitutions"]


def test_a_substitutes_file_the_recipes_dont_bear_out_prints_every_error_and_no_packet(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe, _ = substituting(api_store)
    send = through(api(editor_client))

    failed = packet(BASE_URL, send, SNAPSHOT, quoting(recipe.id, "plonk beans", "quill eggs"))

    assert failed == 1
    printed = capsys.readouterr()
    assert printed.out == ""
    assert f'{recipe.id} i1: "plonk beans" isn\'t in description' in printed.err
    assert f'{recipe.id} i1: "quill eggs" isn\'t in description' in printed.err


def test_apply_writes_each_answered_steps_segments_and_uses(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    steps = [
        Step(id="s1", text="Warm the glimmer oil to 180C for 2 minutes."),
        Step(id="s2", text="Add the snorp garlic."),
    ]
    recipe = add(api_store, "Garlic Tofu")
    original = recipe.original.model_copy(update={"steps": steps})
    recipe = api_store.update_recipe(recipe.model_copy(update={"original": original}))
    send = through(api(editor_client))
    offered = work_packet(send, capsys)
    warm, garlic = offered["recipes"][0]["steps"]
    assert [(o["id"], o["written"]) for o in warm["offers"]] == [
        ("o1", "180C"),
        ("o2", "2 minutes"),
    ]
    assert garlic["default_uses"] == [{"ref": "i2", "portion": 1.0}]
    answered = json.loads(answer_text(offered))
    answered["recipes"][0]["steps"] = [
        {
            "step_id": "s1",
            "keep": ["o1"],
            "ingredients": [{"ref": "i1", "written": "glimmer oil", "portion": 1.0}],
        }
    ]

    failed = apply(BASE_URL, send, SNAPSHOT, json.dumps(answered))

    assert failed == 0
    facts = stored(editor_client, recipe.id)["facts"]["steps"]
    assert sorted(facts) == ["s1"]
    assert [(s["t"], s.get("v") or s["written"]) for s in facts["s1"]["segments"]["segments"]] == [
        ("text", "Warm the "),
        ("ingredient", "glimmer oil"),
        ("text", " to "),
        ("temperature", "180C"),
        ("text", " for 2 minutes."),
    ]
    assert facts["s1"]["uses"]["uses"] == [{"ref": "i1", "portion": 1.0}]


def test_a_new_canonical_named_in_two_recipes_is_created_once(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    first = add(api_store, "Garlic Tofu")
    second = add(api_store, "Chili Noodles")
    send = through(api(editor_client))

    failed = apply(BASE_URL, send, SNAPSHOT, answer_text(work_packet(send, capsys)))

    assert failed == 0
    (created,) = bundle(editor_client)["canonical_ingredients"]
    for recipe in (first, second):
        match = stored(editor_client, recipe.id)["facts"]["ingredients"]["i1"]["match"]
        assert match["canonical_id"] == created["id"]


def test_the_answer_is_read_from_a_file_or_stdin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "answer.json"
    path.write_text('{"from": "file"}')
    monkeypatch.setattr("sys.stdin", io.StringIO('{"from": "stdin"}'))

    assert read_answer(str(path)) == '{"from": "file"}'
    assert read_answer("-") == '{"from": "stdin"}'


def test_a_substitutes_file_that_cant_be_read_stops_with_one_line(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match=r"^Couldn't read .*subs\.jsn: "):
        read_substitutes(str(tmp_path / "subs.jsn"))


def test_a_recipe_whose_offer_changed_is_rejected_and_the_rest_are_written(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    changed = add(api_store, "Garlic Tofu")
    unchanged = add(api_store, "Chili Noodles")
    adapter = api(editor_client)
    offered = work_packet(through(adapter), capsys)
    # Meanwhile, an editor rewrites one of the first recipe's lines, and another recipe arrives.
    lines = [*changed.original.ingredients]
    lines[1] = lines[1].model_copy(update={"text": "4 cloves snorp garlic, minced"})
    original = changed.original.model_copy(update={"ingredients": lines})
    api_store.update_recipe(changed.model_copy(update={"original": original}))
    add(api_store, "Plonk Bean Soup")

    failed = apply(BASE_URL, through(adapter), SNAPSHOT, answer_text(offered))

    assert failed == 1
    assert "Garlic Tofu → rejected, nothing written:\n  its offer changed since the packet" in (
        capsys.readouterr().out
    )
    assert not any(changed.id in (r.url or "") for r in adapter.requests if r.method == "PUT")
    assert stored(editor_client, changed.id)["status"] == "pending"
    assert stored(editor_client, unchanged.id)["status"] == "awaiting_review"


def test_an_answer_that_isnt_an_answer_is_rejected_before_anything_is_read(
    capsys: pytest.CaptureFixture[str],
) -> None:
    adapter = Adapter(lambda _: (500, {}, b""))

    failed = apply(BASE_URL, through(adapter), SNAPSHOT, '{"model": "x", "density": 1}')

    assert failed != 0
    assert adapter.requests == []
    assert "density" in capsys.readouterr().out


def test_a_rejected_recipe_is_not_written_and_the_others_are(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    bad = add(api_store, "Garlic Tofu")
    good = add(api_store, "Chili Noodles")
    send = through(api(editor_client))
    offered = work_packet(send, capsys)
    answered = json.loads(answer_text(offered))
    for recipe in answered["recipes"]:
        if recipe["recipe_id"] == bad.id:
            recipe["lines"] = [oil_line(fdc_id=9999), oil_line(line_id="i3", quantity={"low": 7})]

    failed = apply(BASE_URL, send, SNAPSHOT, json.dumps(answered))

    assert failed == 1
    out = capsys.readouterr().out
    assert "i1: FDC food 9999 wasn't offered" in out
    assert "i3: 7 isn't a number in the line" in out
    assert stored(editor_client, bad.id) == bad.model_dump(mode="json")
    assert stored(editor_client, good.id)["status"] == "awaiting_review"


def test_a_recipe_learning_more_than_one_write_holds_is_rejected_and_the_next_written(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    names = [f"zorb{a}{b} quill eggs" for a in "abcdefg" for b in "abcdefg"]
    lines = [IngredientLine(id=f"i{n}", text=f"2 {name}") for n, name in enumerate(names, 1)]
    many = add(api_store, "Many Eggs", lines=lines)
    after = add(api_store, "Garlic Tofu")
    adapter = api(editor_client)
    offered = work_packet(through(adapter), capsys)
    answered = json.loads(answer_text(offered))
    for answered_recipe, offered_recipe in zip(
        answered["recipes"], offered["recipes"], strict=True
    ):
        if answered_recipe["recipe_id"] == many.id:
            answered_recipe["lines"] = [
                {
                    "line_id": line["line_id"],
                    "canonical": {
                        "new": {"name": name, "family": "egg", "store_category_id": "dairy"}
                    },
                    "fdc_id": line["fdc_candidates"][0]["fdc_id"],
                    "portion_id": None,
                }
                for line, name in zip(offered_recipe["lines"], names, strict=True)
            ]

    failed = apply(BASE_URL, through(adapter), SNAPSHOT, json.dumps(answered))

    assert failed == 1
    assert "Many Eggs → rejected, nothing written" in capsys.readouterr().out
    assert not any(many.id in (r.url or "") for r in adapter.requests if r.method == "PUT")
    assert stored(editor_client, many.id)["status"] == "pending"
    assert stored(editor_client, after.id)["status"] == "awaiting_review"


def test_a_recipe_the_answer_leaves_out_stays_pending(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe = add(api_store, "Garlic Tofu")
    send = through(api(editor_client))
    work_packet(send, capsys)
    answered: dict[str, Any] = {"model": "a-model", "recipes": []}

    assert apply(BASE_URL, send, SNAPSHOT, json.dumps(answered)) == 0
    assert stored(editor_client, recipe.id)["status"] == "pending"


def test_a_wording_an_editor_confirmed_is_used_and_not_learned_again(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    glimmer = CanonicalIngredient(
        id=new_ulid(),
        name="glimmer oil",
        family="oil",
        store_category_id="aisles",
        confirmed=True,
        version=1,
        schema_version=SCHEMA_VERSION,
    )
    confirmed = Wording(
        wording="glimmer oil", canonical_id=glimmer.id, confirmed=True, schema_version=1
    )
    api_store.enrich_recipe(add(api_store, "Ready Stew", status="ready"), [glimmer], [confirmed])
    recipe = add(api_store, "Garlic Tofu")
    send = through(api(editor_client))
    offered = work_packet(send, capsys)
    (oil, *_) = offered["recipes"][0]["lines"]
    assert [c["id"] for c in oil["canonical_candidates"]] == [glimmer.id]

    failed = apply(
        BASE_URL, send, SNAPSHOT, answer_text(offered, oil_line(canonical={"id": glimmer.id}))
    )

    assert failed == 0
    assert (
        stored(editor_client, recipe.id)["facts"]["ingredients"]["i1"]["match"]["canonical_id"]
        == glimmer.id
    )
    assert bundle(editor_client)["wordings"] == [confirmed.model_dump(mode="json")]


def test_a_bulk_import_recipe_goes_straight_to_ready(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe = add(api_store, "Bulk Curry", channel="bulk_import")
    send = through(api(editor_client))

    apply(BASE_URL, send, SNAPSHOT, answer_text(work_packet(send, capsys)))

    assert stored(editor_client, recipe.id)["status"] == "ready"


def test_every_request_carries_the_service_token_and_writes_their_bodys_sha256(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    add(api_store, "Garlic Tofu")
    adapter = api(editor_client)
    offered = work_packet(through(adapter), capsys)

    apply(BASE_URL, through(adapter), SNAPSHOT, answer_text(offered))

    assert all(r.headers[SERVICE_TOKEN_HEADER] == SERVICE_TOKEN for r in adapter.requests)
    writes = [request for request in adapter.requests if request.method == "PUT"]
    assert len(writes) == 1
    body = writes[0].body
    assert isinstance(body, bytes)
    assert writes[0].headers["x-amz-content-sha256"] == hashlib.sha256(body).hexdigest()
    assert writes[0].headers["content-type"] == "application/json"


def test_a_recipe_that_fails_to_write_is_reported_and_the_run_goes_on(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    first = add(api_store, "Garlic Tofu")
    second = add(api_store, "Chili Noodles")
    send = through(api(editor_client))
    offered = work_packet(send, capsys)
    lines = [{**oil_line(), "canonical": {"new": {**NEW_GLIMMER["new"], "name": "glim"}}}]

    def enrich_first_meanwhile(method: str, url: str, body: bytes | None) -> tuple[int, Any]:
        # Someone else enriches the first recipe between the CLI's read and its write.
        if method == "PUT" and first.id in url:
            send("PUT", url, body)
        return send(method, url, body)

    failed = apply(BASE_URL, enrich_first_meanwhile, SNAPSHOT, answer_text(offered, *lines))

    assert failed == 1
    assert stored(editor_client, second.id)["status"] == "awaiting_review"
    out = capsys.readouterr().out
    assert "Garlic Tofu → failed: 409" in out
    assert "Chili Noodles → awaiting_review" in out


def test_a_collection_the_cli_cant_list_fails_and_writes_nothing() -> None:
    # The API lists the Collection to anyone, so the 403 is CloudFront's, as for a blocked IP.
    adapter = Adapter(lambda _: (403, {"content-type": "application/json"}, b'{"message": "no"}'))

    failed = packet("https://plateful.example", through(adapter), SNAPSHOT)

    assert failed != 0
    assert [request.url for request in adapter.requests] == [
        "https://plateful.example/api/collection"
    ]


@pytest.mark.parametrize(
    "text", ["", "   ", "x" * 300], ids=["empty", "whitespace", "300 characters"]
)
def test_a_line_the_parser_cant_read_leaves_its_recipe_and_the_next_still_enriched(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str], text: str
) -> None:
    odd = add(
        api_store,
        "Odd Line Stew",
        lines=[IngredientLine(id="i1", text=text), IngredientLine(id="i2", text="2 quill eggs")],
    )
    after = add(api_store, "Garlic Tofu")
    send = through(api(editor_client))
    offered = work_packet(send, capsys)
    answered: dict[str, Any] = {
        "model": "a-model",
        "recipes": [
            {"recipe_id": r["recipe_id"], "offer_id": r["offer_id"], "lines": []}
            for r in offered["recipes"]
        ],
    }

    failed = apply(BASE_URL, send, SNAPSHOT, json.dumps(answered))

    assert failed == 0
    enriched = stored(editor_client, odd.id)
    assert enriched["status"] == "awaiting_review"
    facts = enriched["facts"]["ingredients"]
    assert "i2" in facts
    # A line too blank to parse has no fact, and the tab shows its text as written.
    assert ("i1" in facts) == bool(text.strip())
    assert all(len(fact["parse"]["name"]) <= MAX_LABEL for fact in facts.values())
    assert stored(editor_client, after.id)["status"] == "awaiting_review"


def redirect_to(location: str) -> Adapter:
    """Redirects the first request to `location`, and answers any other with an empty JSON body."""

    def handle(request: PreparedRequest) -> tuple[int, dict[str, str], bytes]:
        if request.url == "https://plateful.example/api/collection":
            return 307, {"location": location}, b""
        return 200, {"content-type": "application/json"}, b"{}"

    return Adapter(handle)


def test_a_redirect_on_the_same_host_is_followed_with_the_token() -> None:
    adapter = redirect_to("/api/v/collection/3")

    status, _ = through(adapter)("GET", "https://plateful.example/api/collection", None)

    assert status == 200
    assert [request.url for request in adapter.requests][-1] == (
        "https://plateful.example/api/v/collection/3"
    )
    assert adapter.requests[-1].headers[SERVICE_TOKEN_HEADER] == SERVICE_TOKEN


@pytest.mark.parametrize(
    "location",
    ["https://elsewhere.example/api/v/collection/3", "http://plateful.example/api/v/collection/3"],
    ids=["another host", "plain http"],
)
def test_a_redirect_off_the_base_urls_scheme_and_host_is_not_followed(location: str) -> None:
    adapter = redirect_to(location)

    status, _ = through(adapter)("GET", "https://plateful.example/api/collection", None)

    assert status == 307
    assert len(adapter.requests) == 1


@pytest.mark.parametrize(
    "url",
    [
        "https://d111111abcdef8.cloudfront.net",
        "http://localhost:5173",
        "http://127.0.0.1:8787",
        "http://api:8787/",
    ],
)
def test_https_or_a_local_dev_host_is_a_base_url(url: str) -> None:
    assert checked_base_url(url) == url.rstrip("/")


@pytest.mark.parametrize(
    "url", ["http://d111111abcdef8.cloudfront.net", "ftp://localhost", "localhost:5173"]
)
def test_any_other_base_url_is_refused_before_the_token_is_sent(url: str) -> None:
    with pytest.raises(SystemExit, match="https"):
        checked_base_url(url)


def test_main_without_the_service_token_stops_and_says_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PLATEFUL_SERVICE_TOKEN", raising=False)

    with pytest.raises(SystemExit, match="PLATEFUL_SERVICE_TOKEN"):
        main(["packet", "https://d111111abcdef8.cloudfront.net"])


@pytest.mark.parametrize(
    ("argv", "called", "expected"),
    [
        (["substitutes"], "ask", (None,)),
        (["packet", "--substitutes", "f"], "packet", ("snapshot", "quotes", None)),
        (
            ["apply", "a.json", "--substitutes", "f"],
            "apply",
            ("snapshot", "answer text", "quotes", None, False),
        ),
        (
            ["apply", "a.json", "--recipe", "r1", "--recipe", "r2", "--write"],
            "apply",
            ("snapshot", "answer text", "quotes", Chosen(ids=("r1", "r2")), True),
        ),
    ],
    ids=["substitutes", "packet", "apply", "re-enrich"],
)
def test_main_runs_the_command_it_is_given_and_pass_1_needs_no_snapshot(
    monkeypatch: pytest.MonkeyPatch, argv: list[str], called: str, expected: tuple[str, ...]
) -> None:
    url = "https://d111111abcdef8.cloudfront.net"
    monkeypatch.setenv("PLATEFUL_SERVICE_TOKEN", SERVICE_TOKEN)
    calls: list[tuple[str, tuple[Any, ...]]] = []

    def recorder(name: str) -> Any:
        def record(base_url: str, send: object, *rest: Any, **named: Any) -> bool:
            assert send == "send"
            calls.append((name, (base_url, *rest, *named.values())))
            return False

        return record

    def constant(value: str) -> Callable[..., str]:
        return lambda *_args: value

    def no_snapshot() -> object:
        message = "pass 1 doesn't load the snapshot"
        raise AssertionError(message)

    for name in ("ask", "packet", "apply"):
        monkeypatch.setattr(f"recipes.enrich.{name}", recorder(name))
    monkeypatch.setattr("recipes.enrich.SameOriginSession", io.StringIO)
    monkeypatch.setattr("recipes.enrich.send_with", constant("send"))
    monkeypatch.setattr("recipes.enrich.read_answer", constant("answer text"))
    monkeypatch.setattr("recipes.enrich.read_substitutes", constant("quotes"))
    snapshot = constant("snapshot") if called != "ask" else no_snapshot
    monkeypatch.setattr("recipes.enrich.load_snapshot", snapshot)

    with pytest.raises(SystemExit) as stopped:
        main([argv[0], url, *argv[1:]])

    assert stopped.value.code == 0
    assert calls == [(called, (url, *expected))]


def test_apply_prints_each_written_recipes_enrichment_issues_under_its_line(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    glimmer = CanonicalIngredient(
        id=new_ulid(),
        name="glimmer oil",
        family="oil",
        store_category_id="aisles",
        confirmed=True,
        version=1,
        schema_version=SCHEMA_VERSION,
    )
    confirmed = Wording(
        wording="glimmer oil", canonical_id=glimmer.id, confirmed=True, schema_version=1
    )
    api_store.enrich_recipe(add(api_store, "Ready Stew", status="ready"), [glimmer], [confirmed])
    add(api_store, "Garlic Tofu")
    flagged = add(api_store, "Chili Noodles")
    send = through(api(editor_client))
    offered = work_packet(send, capsys)
    oil = oil_line(canonical={"id": glimmer.id})
    answered = json.loads(answer_text(offered, oil))
    for answered_recipe, offered_recipe in zip(
        answered["recipes"], offered["recipes"], strict=True
    ):
        if answered_recipe["recipe_id"] == flagged.id:
            eggs = offered_recipe["lines"][2]
            answered_recipe["lines"].append(
                {
                    "line_id": "i3",
                    "canonical": {
                        "new": {"name": "quill eggs", "family": "egg", "store_category_id": "dairy"}
                    },
                    "fdc_id": eggs["fdc_candidates"][0]["fdc_id"],
                    "portion_id": None,
                    "quantity": {"low": 2},
                    "corrections_reason": "the method uses two",
                }
            )

    assert apply(BASE_URL, send, SNAPSHOT, json.dumps(answered)) == 0

    lines = capsys.readouterr().out.splitlines()
    after_clean = lines[lines.index("Garlic Tofu → awaiting_review") + 1]
    assert not after_clean.startswith(" ")
    out = "\n".join(lines)
    assert (
        "Chili Noodles → awaiting_review\n"
        "  i3.parse: 1-2 → 2 — the method uses two\n"
        "  i3.match: (none) → quill eggs — new Canonical Ingredient quill eggs (egg, Dairy)"
    ) in out


def test_stale_lists_each_recipe_enriched_at_another_version_or_release(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    def enriched_at(title: str, version: int | None, release: str | None) -> Recipe:
        recipe = add(api_store, title, status="ready")
        update = {"enrichment_version": version, "fdc_release": release}
        return api_store.update_recipe(recipe.model_copy(update=update))

    enriched_at("Current Stew", ENRICHMENT_VERSION, SNAPSHOT.release)
    older = enriched_at("Older Stew", 3, SNAPSHOT.release)
    other = enriched_at("Other Release Stew", ENRICHMENT_VERSION, OTHER_RELEASE)
    never = enriched_at("Unversioned Stew", None, None)
    add(api_store, "Pending Stew")
    adapter = api(editor_client)

    assert stale(BASE_URL, through(adapter), SNAPSHOT.release) == 0

    assert {request.method for request in adapter.requests} == {"GET"}
    current = f"(now {ENRICHMENT_VERSION}, {SNAPSHOT.release})"
    assert capsys.readouterr().out.splitlines() == [
        f"{older.id} Older Stew: enrichment version 3, FDC release {SNAPSHOT.release} {current}",
        (
            f"{other.id} Other Release Stew: enrichment version {ENRICHMENT_VERSION}, "
            f"FDC release {OTHER_RELEASE} {current}"
        ),
        f"{never.id} Unversioned Stew: enrichment version none, FDC release none {current}",
    ]


OTHER_RELEASE = "foundation-2026-04-30+sr_legacy-2018-04"
CONFIRMED = {
    "confirmed": True,
    "confirmed_by": "editor@example.com",
    "confirmed_at": "2026-10-01T12:00:00Z",
    "confirm_batch": "batch-1",
}


def reviewed(
    editor_client: TestClient,
    api_store: Store,
    capsys: pytest.CaptureFixture[str],
    conversion: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A recipe the CLI enriched with its glimmer oil matched, then Ready at an older enrichment
    version with the oil line's match Confirmed, or with `conversion`'s fields on its unconfirmed
    conversion. Returns it as the API sends it.
    """
    recipe = add(api_store, "Garlic Tofu")
    send = through(api(editor_client))
    assert apply(BASE_URL, send, SNAPSHOT, answer_text(work_packet(send, capsys))) == 0
    capsys.readouterr()
    enriched = stored(editor_client, recipe.id)
    oil = enriched["facts"]["ingredients"]["i1"]
    if conversion is None:
        oil["match"].update(CONFIRMED)
    else:
        oil["conversion"] |= conversion | {
            "per_100g": oil["conversion"]["per_100g"] | conversion.get("per_100g", {})
        }
    enriched |= {"status": "ready", "ready_batch": "batch-1", "enrichment_version": 3}
    api_store.update_recipe(Recipe.model_validate(enriched))
    return stored(editor_client, recipe.id)


def reenrichment(offered: dict[str, Any]) -> str:
    """An answer that leaves out the Confirmed oil line and matches the quill eggs."""
    eggs = offered["recipes"][0]["lines"][2]
    return answer_text(
        offered,
        {
            "line_id": "i3",
            "canonical": {
                "new": {"name": "quill eggs", "family": "egg", "store_category_id": "dairy"}
            },
            "fdc_id": eggs["fdc_candidates"][0]["fdc_id"],
            "portion_id": None,
        },
    )


def test_reenriching_without_write_prints_the_fact_changes_and_writes_nothing(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    before = reviewed(editor_client, api_store, capsys)
    chosen = Chosen(ids=(before["id"],))
    adapter = api(editor_client)
    send = through(adapter)
    assert packet(BASE_URL, send, SNAPSHOT, None, chosen) == 0
    offered = json.loads(capsys.readouterr().out)

    failed = apply(BASE_URL, send, SNAPSHOT, reenrichment(offered), chosen=chosen)

    assert failed == 0
    assert stored(editor_client, before["id"]) == before
    puts = [request.url for request in adapter.requests if request.method == "PUT"]
    assert puts == [
        f"{BASE_URL}/api/recipes/{before['id']}/enrichment?dry_run=true&version={before['version']}"
    ]
    out = capsys.readouterr().out
    eggs = offered["recipes"][0]["lines"][2]["fdc_candidates"][0]["fdc_id"]
    assert f"  i3.match added: quill eggs (FDC {eggs})" in out
    assert f"  i3.conversion added: FDC {eggs}" in out
    assert f"  enrichment version 3 → {ENRICHMENT_VERSION}" in out
    assert "i1." not in out
    assert "rerun apply with --write" in out


def test_reenriching_with_write_keeps_confirmed_facts_and_updates_the_rest(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    before = reviewed(editor_client, api_store, capsys)
    send = through(api(editor_client))
    assert packet(BASE_URL, send, SNAPSHOT, None, Chosen(stale=SNAPSHOT.release)) == 0
    offered = json.loads(capsys.readouterr().out)

    chosen = Chosen(ids=(before["id"],))
    failed = apply(BASE_URL, send, SNAPSHOT, reenrichment(offered), chosen=chosen, write=True)

    assert failed == 0
    after = stored(editor_client, before["id"])
    lines, was = after["facts"]["ingredients"], before["facts"]["ingredients"]
    assert lines["i1"] == was["i1"]
    assert was["i3"].get("match") is None
    canonicals = bundle(editor_client)["canonical_ingredients"]
    (eggs,) = (c for c in canonicals if c["name"] == "quill eggs")
    assert lines["i3"]["match"]["canonical_id"] == eggs["id"]
    assert lines["i3"]["conversion"]["provenance"] == "fdc"
    assert (after["status"], after["ready_batch"]) == ("ready", "batch-1")
    assert after["enrichment_version"] == ENRICHMENT_VERSION
    out = capsys.readouterr().out
    assert "i3.match added" in out
    assert "i1." not in out
    assert "Garlic Tofu → ready" in out


def test_a_recipe_changed_between_the_dry_run_and_the_write_is_refused(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    before = reviewed(editor_client, api_store, capsys)
    chosen = Chosen(ids=(before["id"],))
    adapter = api(editor_client)
    send = through(adapter)
    assert packet(BASE_URL, send, SNAPSHOT, None, chosen) == 0
    offered = json.loads(capsys.readouterr().out)

    def confirming_meanwhile(method: str, url: str, body: bytes | None) -> tuple[int, Any]:
        # An editor confirms the eggs' parse after the dry run, before the write.
        if method == "PUT" and "dry_run" not in url:
            changed = stored(editor_client, before["id"])
            changed["facts"]["ingredients"]["i3"]["parse"].update(CONFIRMED)
            api_store.update_recipe(Recipe.model_validate(changed))
        return send(method, url, body)

    failed = apply(
        BASE_URL, confirming_meanwhile, SNAPSHOT, reenrichment(offered), chosen=chosen, write=True
    )

    assert failed == 1
    after = stored(editor_client, before["id"])
    assert after["version"] == before["version"] + 1
    assert after["facts"]["ingredients"]["i3"]["parse"]["confirmed"]
    assert after["facts"]["ingredients"]["i3"].get("match") is None
    puts = [request.url for request in adapter.requests if request.method == "PUT"]
    url = f"{BASE_URL}/api/recipes/{before['id']}/enrichment"
    assert puts[1] == f"{url}?version={before['version']}"
    assert "changed since" in capsys.readouterr().out


def test_a_recipe_an_editor_changed_after_the_dry_run_is_refused_by_the_write(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    before = reviewed(editor_client, api_store, capsys)
    chosen = Chosen(ids=(before["id"],))
    adapter = api(editor_client)
    send = through(adapter)
    assert packet(BASE_URL, send, SNAPSHOT, None, chosen) == 0
    answered = reenrichment(json.loads(capsys.readouterr().out))
    assert apply(BASE_URL, send, SNAPSHOT, answered, chosen=chosen) == 0
    # After the dry run an editor resolves the oil's issue, leaving its kept items as they were.
    changed = stored(editor_client, before["id"])
    assert changed["issues"]
    for issue in changed["issues"]:
        issue["status"] = "resolved"
    changed = api_store.update_recipe(Recipe.model_validate(changed)).model_dump(mode="json")
    capsys.readouterr()
    adapter.requests.clear()

    failed = apply(BASE_URL, send, SNAPSHOT, answered, chosen=chosen, write=True)

    assert failed == 1
    assert [r.method for r in adapter.requests if r.method != "GET"] == []
    assert stored(editor_client, before["id"]) == changed
    assert "its offer changed since the packet" in capsys.readouterr().out


def test_reenriching_a_pending_or_unknown_recipe_is_refused(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    pending = add(api_store, "Pending Stew")
    send = through(api(editor_client))

    assert packet(BASE_URL, send, SNAPSHOT, None, Chosen(ids=(pending.id, "01NOTARECIPE"))) == 1

    err = capsys.readouterr().err
    assert f"{pending.id} Pending Stew is Pending: enrich it without --recipe" in err
    assert "01NOTARECIPE isn't a recipe in the Collection" in err


def test_write_without_chosen_recipes_is_refused(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as stopped:
        main(["apply", "https://d111111abcdef8.cloudfront.net", "a.json", "--write"])

    assert stopped.value.code == 2
    assert "--write needs --recipe or --stale" in capsys.readouterr().err


def test_packet_with_recipe_offers_only_that_recipe(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    chosen = add(api_store, "Ready Stew", status="ready")
    add(api_store, "Other Stew", status="ready")
    add(api_store, "Garlic Tofu")

    send = through(api(editor_client))
    assert packet(BASE_URL, send, SNAPSHOT, None, Chosen(ids=(chosen.id,))) == 0

    assert [r["recipe_id"] for r in json.loads(capsys.readouterr().out)["recipes"]] == [chosen.id]


def test_the_dry_run_shows_removed_facts_issue_changes_and_the_fdc_release(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    # The oil line is unconfirmed, with its open new-canonical issue, at another release.
    before = reviewed(editor_client, api_store, capsys, conversion={})
    at_other = Recipe.model_validate(before | {"fdc_release": OTHER_RELEASE})
    before = api_store.update_recipe(at_other).model_dump(mode="json")
    chosen = Chosen(ids=(before["id"],))
    send = through(api(editor_client))
    assert packet(BASE_URL, send, SNAPSHOT, None, chosen) == 0
    offered = json.loads(capsys.readouterr().out)
    eggs = offered["recipes"][0]["lines"][2]["fdc_candidates"][0]["fdc_id"]
    new_eggs = {"name": "quill eggs", "family": "egg", "store_category_id": "dairy"}
    answer = answer_text(
        offered,
        {"line_id": "i3", "canonical": {"new": new_eggs}, "fdc_id": eggs, "portion_id": None},
    )

    assert apply(BASE_URL, send, SNAPSHOT, answer, chosen=chosen) == 0

    out = capsys.readouterr().out.splitlines()
    assert "  i1.match removed: glimmer oil (FDC 2004)" in out
    assert "  i1.conversion removed: FDC 2004" in out
    assert (
        "  issue dropped: i1.match: (none) → glimmer oil — "
        "new Canonical Ingredient glimmer oil (oil, Aisles)"
    ) in out
    assert (
        "  issue added: i3.match: (none) → quill eggs — "
        "new Canonical Ingredient quill eggs (egg, Dairy)"
    ) in out
    assert f"  FDC release {OTHER_RELEASE} → {SNAPSHOT.release}" in out


def test_a_recipe_named_twice_is_offered_once(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    chosen = add(api_store, "Ready Stew", status="ready")
    adapter = api(editor_client)

    twice = Chosen(ids=(chosen.id, chosen.id))
    assert packet(BASE_URL, through(adapter), SNAPSHOT, None, twice) == 0

    assert [r["recipe_id"] for r in json.loads(capsys.readouterr().out)["recipes"]] == [chosen.id]
    reads = [r.url for r in adapter.requests if r.url == f"{BASE_URL}/api/recipes/{chosen.id}"]
    assert len(reads) == 1


def test_a_conversion_changed_under_the_same_fdc_food_shows_what_differs(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    density = 13.5 / 14.78676478125
    older = {"release": OTHER_RELEASE, "density_g_per_ml": 0.8, "per_100g": {"kcal": 800}}
    before = reviewed(editor_client, api_store, capsys, conversion=older)
    chosen = Chosen(ids=(before["id"],))
    send = through(api(editor_client))
    assert packet(BASE_URL, send, SNAPSHOT, None, chosen) == 0
    offered = json.loads(capsys.readouterr().out)

    assert apply(BASE_URL, send, SNAPSHOT, answer_text(offered), chosen=chosen) == 0

    out = capsys.readouterr().out
    assert (
        f"  i1.conversion changed: FDC 2004: release {OTHER_RELEASE} → {SNAPSHOT.release}, "
        f"density_g_per_ml 0.8 → {density:g}, per_100g.kcal 800 → 884"
    ) in out


def margarine_kept(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> tuple[Recipe, CanonicalIngredient]:
    """A recipe that says zorbleberry oil works in place of its glimmer oil, enriched, then Ready
    with an editor's Confirmed match of the oil line to zorbleberry. Returns it as stored.
    """
    recipe, zorbleberry = substituting(api_store)
    send = through(api(editor_client))
    assert apply(BASE_URL, send, SNAPSHOT, answer_text(work_packet(send, capsys))) == 0
    capsys.readouterr()
    enriched = stored(editor_client, recipe.id)
    enriched["facts"]["ingredients"]["i1"]["match"] |= CONFIRMED | {"canonical_id": zorbleberry.id}
    enriched |= {"status": "ready", "ready_batch": "batch-1", "enrichment_version": 3}
    return api_store.update_recipe(Recipe.model_validate(enriched)), zorbleberry


def test_reenriching_offers_a_confirmed_match_and_refuses_it_as_a_substitute_then_writes(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    before, zorbleberry = margarine_kept(editor_client, api_store, capsys)
    # Another recipe made a berry oil, offered as the quoted substitute's other candidate.
    berry_oil = zorbleberry.model_copy(update={"id": new_ulid(), "name": "berry oil"})
    api_store.enrich_recipe(add(api_store, "Berry Stew", status="ready"), [berry_oil], [])
    chosen = Chosen(ids=(before.id,))
    quoted = quoting(before.id, "zorbleberry oil")
    adapter = api(editor_client)
    send = through(adapter)
    assert packet(BASE_URL, send, SNAPSHOT, quoted, chosen) == 0
    offered = json.loads(capsys.readouterr().out)
    oil = offered["recipes"][0]["lines"][0]
    assert oil["confirmed"]["canonical"] == {"id": zorbleberry.id, "name": "zorbleberry"}
    substitute = json.loads(substituted_answer(offered, zorbleberry.id))["recipes"][0]
    del substitute["difficulty"]
    substitutions = substitute["lines"][0]["substitutions"]
    substitute["lines"] = [{"line_id": "i1", "substitutions": substitutions}]
    clashing = {"model": "a-model", "recipes": [substitute]}

    failed = apply(
        BASE_URL, send, SNAPSHOT, json.dumps(clashing), quoted, chosen=chosen, write=True
    )

    assert failed == 1
    assert [r.method for r in adapter.requests if r.method != "GET"] == []
    assert stored(editor_client, before.id)["version"] == before.version
    assert (
        f"  i1: substitute zorbleberry oil: Canonical Ingredient {zorbleberry.id} is the line's "
        "confirmed match"
    ) in capsys.readouterr().out

    accepted = json.loads(reenrichment(offered))
    other = substitutions[0] | {"canonical_id": berry_oil.id}
    accepted["recipes"][0]["lines"].append({"line_id": "i1", "substitutions": [other]})
    answered = json.dumps(accepted)
    failed = apply(BASE_URL, send, SNAPSHOT, answered, quoted, chosen=chosen, write=True)

    assert failed == 0
    after = stored(editor_client, before.id)
    oil, was = after["facts"]["ingredients"]["i1"], before.facts.ingredients["i1"]
    assert (oil["match"], oil["conversion"]) == (
        was.model_dump(mode="json")["match"],
        was.model_dump(mode="json")["conversion"],
    )
    assert [item["canonical_id"] for item in oil["substitutions"]["items"]] == [berry_oil.id]
    assert after["facts"]["ingredients"]["i3"]["match"] is not None
    assert after["enrichment_version"] == ENRICHMENT_VERSION


def test_reenriching_refuses_portions_that_with_a_confirmed_steps_use_more_than_a_line(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    steps = [
        Step(id="s1", text="Warm the glimmer oil."),
        Step(id="s2", text="Add the glimmer oil."),
    ]
    recipe = add(api_store, "Oil Stew", status="ready")
    kept = {"provenance": "editor", "confidence": 1, "estimated": False, **CONFIRMED}
    facts = {"steps": {"s1": {"uses": {**kept, "uses": [{"ref": "i1", "portion": 0.7}]}}}}
    original = recipe.original.model_copy(update={"steps": steps})
    changed = recipe.model_dump() | {"original": original, "facts": facts}
    before = api_store.update_recipe(Recipe.model_validate(changed))
    chosen = Chosen(ids=(before.id,))
    adapter = api(editor_client)
    send = through(adapter)
    assert packet(BASE_URL, send, SNAPSHOT, None, chosen) == 0
    offered = json.loads(capsys.readouterr().out)
    assert offered["recipes"][0]["steps"][0]["confirmed_uses"] == [{"ref": "i1", "portion": 0.7}]
    answered = json.loads(answer_text(offered))
    answered["recipes"][0]["steps"] = [
        {"step_id": "s2", "ingredients": [{"ref": "i1", "written": "glimmer oil", "portion": 0.5}]}
    ]

    failed = apply(BASE_URL, send, SNAPSHOT, json.dumps(answered), chosen=chosen, write=True)

    assert failed == 1
    assert [r.method for r in adapter.requests if r.method != "GET"] == []
    assert stored(editor_client, before.id)["version"] == before.version
    assert (
        "Oil Stew → rejected, nothing written:\n"
        "  i1: its portions add up to 1.2 with the confirmed steps' 0.7, more than all of it"
    ) in capsys.readouterr().out


# Our Version


def our_answer(offered: dict[str, Any], *steps: dict[str, Any]) -> str:
    """A model's answer to the packet's one Our Version: `steps`, or the stew's s2 using half the
    beef and s5 left as its text.
    """
    (ours,) = offered["our_versions"]
    answered = steps or (
        {"step_id": "s2", "ingredients": [{"ref": "i1", "written": "beef", "portion": 0.5}]},
        {"step_id": "s5"},
    )
    return json.dumps(
        {
            "model": "a-model",
            "recipes": [],
            "our_versions": [
                {"recipe_id": ours["recipe_id"], "offer_id": ours["offer_id"], "steps": answered}
            ],
        }
    )


def test_packet_offers_our_versions_waiting_steps_against_the_effective_lines_unparsed(
    editor_client: TestClient,
    api_store: Store,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recipe = our_version_pending(api_store)
    monkeypatch.setattr("recipes.packet.parse_line", unparseable)

    offered = work_packet(through(api(editor_client)), capsys)

    assert offered["recipes"] == []
    (ours,) = offered["our_versions"]
    assert (ours["recipe_id"], ours["version"]) == (recipe.id, recipe.version)
    assert [s["step_id"] for s in ours["steps"]] == ["s2", "s5"]
    assert ours["steps"][0]["text"] == "Brown the beef well."
    shown = effective(recipe)
    assert [ln["line_id"] for ln in ours["lines"]] == [line.id for line in shown.ingredients]
    beef = ours["lines"][0]
    assert (beef["parse"]["name"], beef["parse"]["quantity"]) == (
        "stewing beef",
        {"low": 1, "high": 1},
    )
    assert "our_versions" in offered["instructions"]


def test_the_our_version_offer_reads_a_line_holding_only_substitutions_as_the_originals(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe = our_version_pending(api_store)
    ours = recipe.our_version
    assert ours is not None
    kept = {"provenance": "editor", "confidence": 1, "estimated": False, **CONFIRMED}
    household = SubstitutionsFact.model_validate({**kept, "items": [SWAP]})
    facts = ours.facts.model_copy(
        update={"ingredients": {"i1": IngredientFacts(substitutions=household)}}
    )
    held = recipe.model_copy(update={"our_version": ours.model_copy(update={"facts": facts})})
    recipe = api_store.update_recipe(held)

    (offered,) = work_packet(through(api(editor_client)), capsys)["our_versions"]

    beef = offered["lines"][0]
    assert (beef["line_id"], beef["text"]) == ("i1", "900 g stewing beef, cubed")
    assert (beef["parse"]["name"], beef["parse"]["quantity"]) == (
        "stewing beef",
        {"low": 1, "high": 1},
    )


def test_the_our_version_offer_shows_the_other_effective_steps_as_context(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    half_the_beef = [{"ref": "i1", "portion": 0.5}]
    used = StepFacts(uses=UsesFact.model_validate({**LLM, "uses": half_the_beef}))
    recipe = our_version_pending(api_store, FACTS.model_copy(update={"steps": {"s1": used}}))

    (ours,) = work_packet(through(api(editor_client)), capsys)["our_versions"]

    shown = effective(recipe)
    others = [step for step in shown.steps if step.id not in {"s2", "s5"}]
    assert [(s["step_id"], s["text"]) for s in ours["context_steps"]] == [
        (step.id, step.text) for step in others
    ]
    assert ours["context_steps"][0]["uses"] == half_the_beef
    assert "context_steps" in work_packet(through(api(editor_client)), capsys)["instructions"]


def unparseable(text: str) -> None:
    msg = f"parsed {text}"
    raise AssertionError(msg)


def test_apply_writes_our_versions_steps_through_its_endpoint_and_it_awaits_review(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe = our_version_pending(api_store)
    adapter = api(editor_client)
    send = through(adapter)
    offered = work_packet(send, capsys)

    failed = apply(BASE_URL, send, SNAPSHOT, our_answer(offered))

    assert failed == 0
    assert f"{recipe.original.title} → Our Version awaiting_review" in capsys.readouterr().out
    assert [r.url for r in adapter.requests if r.method == "PUT"] == [
        f"{BASE_URL}/api/recipes/{recipe.id}/our-version/enrichment"
    ]
    after = stored(editor_client, recipe.id)
    assert (after["status"], after["our_version_status"]) == ("ready", "awaiting_review")
    assert after["facts"] == recipe.facts.model_dump(mode="json")
    steps = after["our_version"]["facts"]["steps"]
    assert [(s["t"], s.get("v") or s["written"]) for s in steps["s2"]["segments"]["segments"]] == [
        ("text", "Brown the "),
        ("ingredient", "beef"),
        ("text", " well."),
    ]
    assert steps["s2"]["uses"]["uses"] == [{"ref": "i1", "portion": 0.5}]
    assert [s["t"] for s in steps["s5"]["segments"]["segments"]] == ["text"]


def test_our_versions_portions_past_1_are_left_for_the_api_to_cap_and_its_issue_printed(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    all_of_it = [{"ref": "i1", "portion": 1}]
    all_the_beef = StepFacts(uses=UsesFact.model_validate({**LLM, "uses": all_of_it}))
    facts = FACTS.model_copy(update={"steps": {"s1": all_the_beef}})
    recipe = our_version_pending(api_store, facts)
    send = through(api(editor_client))
    offered = work_packet(send, capsys)

    failed = apply(BASE_URL, send, SNAPSHOT, our_answer(offered))

    assert failed == 0
    out = capsys.readouterr().out
    assert f"{recipe.original.title} → Our Version awaiting_review\n  our_version.s2." in out
    after = stored(editor_client, recipe.id)
    assert after["our_version"]["facts"]["steps"]["s2"]["uses"]["uses"] == []


def test_an_our_version_whose_offer_changed_is_rejected_and_nothing_written(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe = our_version_pending(api_store)
    adapter = api(editor_client)
    offered = work_packet(through(adapter), capsys)
    # Meanwhile, an editor writes a note on Our Version.
    assert recipe.our_version is not None
    ours = recipe.our_version.model_copy(update={"note": "Brown it hard."})
    api_store.update_recipe(recipe.model_copy(update={"our_version": ours}))

    failed = apply(BASE_URL, through(adapter), SNAPSHOT, our_answer(offered))

    assert failed == 1
    rejected = f"{recipe.original.title} → rejected, nothing written:\n  its offer changed"
    assert rejected in capsys.readouterr().out
    assert [r.method for r in adapter.requests if r.method != "GET"] == []
    assert stored(editor_client, recipe.id)["our_version_status"] == "pending"


def test_an_our_version_answer_leaving_out_a_waiting_step_is_rejected(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe = our_version_pending(api_store)
    adapter = api(editor_client)
    send = through(adapter)
    offered = work_packet(send, capsys)

    failed = apply(BASE_URL, send, SNAPSHOT, our_answer(offered, {"step_id": "s2"}))

    assert failed == 1
    assert (
        f"{recipe.original.title} → rejected, nothing written:\n  s5: answer every step"
    ) in capsys.readouterr().out
    assert [r.method for r in adapter.requests if r.method != "GET"] == []
