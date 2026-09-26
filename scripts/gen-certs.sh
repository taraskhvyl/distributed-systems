#!/bin/sh
set -e
mkdir -p gateway/certs
if [ -f gateway/certs/server.crt ] && [ -f gateway/certs/server.key ]; then
  echo "TLS certificate already exists (gateway/certs/server.crt)"
  exit 0
fi
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout gateway/certs/server.key \
  -out gateway/certs/server.crt \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:*.localhost"
echo "Generated self-signed certificate for localhost + *.localhost"
