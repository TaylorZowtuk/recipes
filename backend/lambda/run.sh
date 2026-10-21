#!/bin/bash
# The Lambda handler. The Web Adapter layer (AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap) runs this from
# the unzipped package and forwards each request to uvicorn on $PORT, 8080 by default.
exec python -m uvicorn recipes.api:app --host 127.0.0.1 --port "${PORT:-8080}"
