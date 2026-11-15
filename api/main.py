"""RepurposeKG backend.

    uvicorn api.main:app --reload --port 8000

Then open http://localhost:8000/docs for the interactive API.
Artifacts load once at startup into memory; every request after that is served
without touching the original 21.8M-edge graph.

Environment:
    LOG_LEVEL     INFO (default) or DEBUG for per-step timing
    LOG_FORMAT    json when hosted, plain text otherwise
    CORS_ORIGINS  comma-separated frontend origins; default allows any localhost port
    ARTIFACT_DIR  defaults to ./artifacts
"""

from __future__ import annotations

import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse

from api.logging_setup import new_request_id, request_id, setup_logging, timed
from api.models import (CandidatesResponse, DiseaseHit, DiseaseSummary, Health,
                        PathsResponse)
from api.scoring import Scorer
from api.search import DiseaseSearch

setup_logging()
log = logging.getLogger("repurposekg")

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get("ARTIFACT_DIR", ROOT / "artifacts"))

state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    started = time.perf_counter()
    log.info("loading artifacts from %s", ARTIFACTS)
    scorer = Scorer(ARTIFACTS)
    state["scorer"] = scorer
    state["search"] = DiseaseSearch(scorer.diseases)
    state["started_at"] = time.time()

    meta_path = ARTIFACTS / "meta.json"
    state["meta"] = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    eval_path = ARTIFACTS / "eval.json"
    state["eval"] = json.loads(eval_path.read_text()) if eval_path.exists() else None

    log.info(
        "ready in %.1fs: %d drugs (%d approved), %d diseases, %d genes; "
        "layers chem=%s homolog=%s; weights %s",
        time.perf_counter() - started, scorer.drugs.height, int(scorer.is_approved.sum()),
        scorer.diseases.height, scorer.genes.height, scorer.has_chem, scorer.has_homolog,
        scorer.w,
    )
    if state["eval"] is None:
        log.warning("artifacts/eval.json missing; /api/eval will return 404. "
                    "Run: python scripts/rediscovery.py --tune")
    yield
    log.info("shutting down")


app = FastAPI(
    title="RepurposeKG",
    description="Drug repurposing candidates with traceable biological paths. "
                "Research hypothesis generation only, never treatment advice.",
    version="0.1.0",
    lifespan=lifespan,
)

origins = os.environ.get("CORS_ORIGINS")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in origins.split(",")] if origins else ["*"],
    allow_origin_regex=None if origins else r"http://(localhost|127\.0\.0\.1):\d+",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    rid = new_request_id()
    token = request_id.set(rid)
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        ms = (time.perf_counter() - started) * 1000
        log.exception("%s %s failed after %.0fms", request.method, request.url.path, ms)
        request_id.reset(token)
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error",
                     "detail": "Something broke on our side. Quote the request id.",
                     "request_id": rid},
        )
    ms = (time.perf_counter() - started) * 1000
    query = f"?{request.url.query}" if request.url.query else ""
    log.info("%s %s%s -> %d in %.0fms",
             request.method, request.url.path, query, response.status_code, ms)
    response.headers["X-Request-Id"] = rid
    response.headers["X-Response-Time-Ms"] = f"{ms:.0f}"
    request_id.reset(token)
    return response


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    log.warning("%s %s -> %d: %s", request.method, request.url.path, exc.status_code, exc.detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": "not_found" if exc.status_code == 404 else "bad_request",
                 "detail": str(exc.detail), "request_id": request_id.get()},
    )


def scorer() -> Scorer:
    return state["scorer"]


def resolve_disease(disease_id: str) -> int:
    j = scorer().disease_idx.get(disease_id)
    if j is None:
        raise HTTPException(404, f"No disease with id {disease_id!r}. "
                                 f"Use /api/diseases/search to find one.")
    return j


# --------------------------------------------------------------------- routes
@app.get("/", include_in_schema=False)
def index():
    """Opening the bare host should land somewhere useful, not on a 404."""
    return RedirectResponse("/docs")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    """Browsers always ask; answer quietly instead of logging a 404 each time."""
    return Response(status_code=204)


@app.get("/api/health", response_model=Health, tags=["meta"])
def health() -> Health:
    s = scorer()
    return Health(
        status="ok",
        drugs=s.drugs.height,
        approved_drugs=int(s.is_approved.sum()),
        diseases=s.diseases.height,
        genes=s.genes.height,
        layers={"chemical_analog": s.has_chem, "protein_homolog": s.has_homolog},
        weights=s.w,
        artifacts_built_at=state["meta"].get("built_at"),
        uptime_seconds=round(time.time() - state["started_at"], 1),
    )


@app.get("/api/diseases/search", response_model=list[DiseaseHit], tags=["diseases"])
def search_diseases(
    q: str = Query(min_length=2, description="disease name or synonym"),
    limit: int = Query(10, ge=1, le=50),
) -> list[DiseaseHit]:
    with timed(log, "disease search", query=q) as step:
        hits = state["search"].search(q, limit)
        step["hits"] = len(hits)
        step["best"] = hits[0]["name"] if hits else None
    return [DiseaseHit(**h) for h in hits]


@app.get("/api/diseases/{disease_id}", response_model=DiseaseSummary, tags=["diseases"])
def disease_detail(disease_id: str) -> DiseaseSummary:
    return DiseaseSummary(**scorer().disease_summary(resolve_disease(disease_id)))


@app.get("/api/diseases/{disease_id}/candidates", response_model=CandidatesResponse,
         tags=["candidates"])
def candidates(
    disease_id: str,
    limit: int = Query(50, ge=1, le=200, description="per list, not combined"),
) -> CandidatesResponse:
    resolve_disease(disease_id)
    s = scorer()
    with timed(log, "candidates", level=logging.INFO, disease=disease_id) as step:
        result = s.candidates(disease_id, limit=limit)
        step["name"] = result["disease"]["name"]
        step["n_genes"] = result["disease"]["n_genes"]
        step["approved"] = len(result["approved"])
        step["investigational"] = len(result["investigational"])
        step["excluded"] = result["excluded_count"]
        if result["warning"]:
            step["warning"] = result["warning"]
    if result["warning"]:
        log.warning("%s has weak graph coverage (%d genes); results will be thin",
                    result["disease"]["name"], result["disease"]["n_genes"])
    return CandidatesResponse(**result)


@app.get("/api/paths", response_model=PathsResponse, tags=["candidates"])
def paths(
    drug_id: str = Query(description="ChEMBL id, e.g. CHEMBL1201607"),
    disease_id: str = Query(description="e.g. MONDO_0005301"),
) -> PathsResponse:
    resolve_disease(disease_id)
    s = scorer()
    if drug_id not in s.drug_idx:
        raise HTTPException(404, f"No drug with id {drug_id!r}")
    with timed(log, "paths", level=logging.INFO, drug=drug_id, disease=disease_id) as step:
        result = s.paths(drug_id, disease_id)
        step["paths"] = len(result["paths"])
        step["inferred"] = sum(1 for p in result["paths"] if p["inferred"])
        step["types"] = ",".join(sorted({p["type"] for p in result["paths"]})) or "none"
    return PathsResponse(**result)


@app.get("/api/eval", tags=["meta"])
def evaluation() -> dict:
    """Rediscovery results: how often a hidden known treatment comes back in the top 10."""
    if state["eval"] is None:
        raise HTTPException(404, "No eval.json yet. Run: python scripts/rediscovery.py --tune")
    return state["eval"]
