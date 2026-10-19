from fastapi import FastAPI

app = FastAPI(title="Raibit FastAPI starter")


@app.get('/healthz')
def healthz() -> dict[str, str]:
    return {'status': 'ok'}


@app.get('/')
def root() -> dict[str, str]:
    return {'message': 'Ready to build on RAIBITSERVER.'}
