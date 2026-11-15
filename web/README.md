# RepurposeKG web

Next.js (App Router) + TypeScript + Tailwind v4 + TanStack Query + Cytoscape.js. "Flow" design: soft, organic, no boxes.

## Run it

```bash
# 1. backend, from the repo root (see the main README for the venv)
python -m uvicorn api.main:app --port 8000

# 2. frontend
cd web
npm install
cp .env.example .env.local      # NEXT_PUBLIC_API_URL=http://127.0.0.1:8000
npm run dev                     # http://localhost:3000
```

If port 8000 is taken on your machine, start the backend on another port and change `NEXT_PUBLIC_API_URL` to match.
Restart `npm run dev` after editing `.env.local`.

With no `NEXT_PUBLIC_API_URL` the app runs on an **offline snapshot** of real backend results
(`src/lib/fixtures/`, three demo diseases) and shows an "Offline snapshot" badge.

## Pages

| Route | Page |
|:-|:-|
| `/` | Product page: animated hero, path-type explorer, live mini demo, rediscovery numbers, **Try me** |
| `/app` | Try it: disease search and example diseases |
| `/d/:diseaseId` | Two ranked lists (Approved / Not approved) |
| `/d/:diseaseId/:drugId` | Same, with the detail sheet (Path · Structure · Brief) |
| `/validation` | Rediscovery results from `/api/eval` |

## Notes

- `src/lib/types.ts` mirrors `api/models.py`; `src/lib/api.ts` holds every fetcher.
- **Brief:** `/api/brief` is not built yet. Until it is, the Brief tab shows a sample made only from live graph paths and trial IDs, labelled as such.
- **Structure:** `src/components/StructurePlaceholder.tsx` holds the slot. `StructureViewer.tsx` is still the Vite version and is
  excluded from `tsconfig.json` and `eslint.config.mjs` until its Next.js port lands; remove both exclusions when it does.
- Wheel-zoom on the path graph is off on purpose (it hijacked page scroll and froze the tab). Drag to pan, "Re-center" to refit.
