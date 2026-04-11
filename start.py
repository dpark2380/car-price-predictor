"""
Startup wrapper for Railway deployment.
Catches import/startup errors and prints them explicitly before exiting.
"""
import sys
import os
import traceback

print("=== startup: testing imports ===", flush=True)

try:
    import flask
    print(f"flask OK ({flask.__version__})", flush=True)
except Exception as e:
    print(f"flask FAILED: {e}", flush=True)
    traceback.print_exc()

try:
    import sqlalchemy
    print(f"sqlalchemy OK ({sqlalchemy.__version__})", flush=True)
except Exception as e:
    print(f"sqlalchemy FAILED: {e}", flush=True)
    traceback.print_exc()

try:
    import pandas
    print(f"pandas OK ({pandas.__version__})", flush=True)
except Exception as e:
    print(f"pandas FAILED: {e}", flush=True)
    traceback.print_exc()

try:
    import xgboost
    print(f"xgboost OK ({xgboost.__version__})", flush=True)
except Exception as e:
    print(f"xgboost FAILED: {e}", flush=True)
    traceback.print_exc()

try:
    from db.models import init_db, get_session
    print("db.models OK", flush=True)
except Exception as e:
    print(f"db.models FAILED: {e}", flush=True)
    traceback.print_exc()

try:
    from db.repository import ListingRepository, PredictionRepository, PopularityRepository
    print("db.repository OK", flush=True)
except Exception as e:
    print(f"db.repository FAILED: {e}", flush=True)
    traceback.print_exc()

try:
    import api
    print("api import OK", flush=True)
except Exception as e:
    print(f"api FAILED: {e}", flush=True)
    traceback.print_exc()
    sys.exit(1)

print("=== all imports OK, starting server ===", flush=True)

port = int(os.environ.get("PORT", 5001))
api.app.run(host="0.0.0.0", port=port, debug=False)
