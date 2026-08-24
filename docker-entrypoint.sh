#!/bin/sh
set -e

# GOOGLE_APPLICATION_CREDENTIALS must be a file path (Google's ADC lookup),
# but the actual key can't be baked into the image (gitignored secret) or
# stored as a file-path env var on a host with no persistent filesystem.
# Railway instead gets the key's raw JSON via GCP_SERVICE_ACCOUNT_JSON and
# this writes it to the path GOOGLE_APPLICATION_CREDENTIALS already points
# at before the app starts.
if [ -n "$GCP_SERVICE_ACCOUNT_JSON" ]; then
  mkdir -p secrets
  printf '%s' "$GCP_SERVICE_ACCOUNT_JSON" > "${GOOGLE_APPLICATION_CREDENTIALS:-./secrets/gcp-speech-service-account.json}"
fi

exec "$@"
