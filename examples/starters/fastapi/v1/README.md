# FastAPI starter v1

This single web service runs Python 3.13, FastAPI 0.141.1, and Uvicorn 0.52.4. It needs no database or secret. `GET /healthz` returns a local readiness response.

The Dockerfile installs the resolver-generated, hash-locked dependency graph from `requirements.lock` and runs `python -m uvicorn app.main:app`.
