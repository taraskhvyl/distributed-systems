#!/bin/sh
# Local CA + server cert (the mkcert pattern). Trust ca.crt once in your OS/browser;
# the server cert can then be reissued without touching the trust store again.
set -e
d=gateway/certs
mkdir -p "$d"

# The server cert must name every host explicitly: browsers reject `*.localhost`
# (a wildcard directly under a single-label TLD), and macOS requires EKU serverAuth.
# ponytail: fixed host list, add a name here (and rm server.crt) when a new *.localhost host appears.
SANS="DNS:localhost,DNS:app.localhost,DNS:api.localhost,DNS:auth.localhost,DNS:s3.localhost"

if [ -f "$d/server.crt" ] && openssl x509 -in "$d/server.crt" -noout -ext subjectAltName | grep -q app.localhost; then
  echo "TLS certificate already exists (gateway/certs/server.crt)"
  exit 0
fi

if [ ! -f "$d/ca.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$d/ca.key" -out "$d/ca.crt" \
    -subj "/CN=mediashare local dev CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  echo "Generated local CA: $d/ca.crt (trust this one, see README)"
fi

cat > "$d/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SANS
EOF
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
  -keyout "$d/server.key" -out "$d/server.csr"
openssl x509 -req -in "$d/server.csr" -CA "$d/ca.crt" -CAkey "$d/ca.key" -CAcreateserial \
  -days 825 -extfile "$d/server.ext" -out "$d/server.crt"
rm -f "$d/server.csr" "$d/server.ext"
echo "Generated server certificate for: $SANS"
