#!/usr/bin/env bash
# Builds a CA bundle that can validate https://ghconline.gov.in.
#
# The Court's server sends only its leaf certificate (no intermediate), so clients without AIA chasing
# (curl, workerd, Python/httpx) fail with "unable to get local issuer certificate". This script downloads the
# missing intermediate from the leaf certificate's own AIA "CA Issuers" URL, VERIFIES that it chains to a root in
# your system trust store, and only then appends it. Certificate verification is never disabled.
#
# usage: scripts/build-ca-bundle.sh [output.pem]     (default: .local/ghconline-ca-bundle.pem)
set -euo pipefail
HOST="${HOST:-ghconline.gov.in}"
OUT="${1:-.local/ghconline-ca-bundle.pem}"
SYSTEM_CA="${SYSTEM_CA:-/etc/ssl/certs/ca-certificates.crt}"
mkdir -p "$(dirname "$OUT")"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

echo | openssl s_client -connect "$HOST:443" -servername "$HOST" 2>/dev/null | openssl x509 -outform PEM > "$tmp/leaf.pem"
url="$(openssl x509 -in "$tmp/leaf.pem" -noout -text | sed -n 's/.*CA Issuers - URI:\(.*\)/\1/p' | head -1)"
[ -n "$url" ] || { echo "leaf certificate has no AIA CA Issuers URL" >&2; exit 1; }
echo "fetching intermediate from $url"
curl -fsS --max-time 30 -o "$tmp/inter.der" "$url"
openssl x509 -inform DER -in "$tmp/inter.der" -out "$tmp/inter.pem" 2>/dev/null || cp "$tmp/inter.der" "$tmp/inter.pem"

# The intermediate must be signed by a root we already trust, and the leaf by the intermediate.
openssl verify -CAfile "$SYSTEM_CA" "$tmp/inter.pem" >/dev/null
openssl verify -CAfile "$SYSTEM_CA" -untrusted "$tmp/inter.pem" "$tmp/leaf.pem" >/dev/null
cat "$tmp/inter.pem" "$SYSTEM_CA" > "$OUT"

curl -fsS --max-time 30 --cacert "$OUT" -o /dev/null "https://$HOST/robots.txt"
echo "wrote $OUT (verified: leaf -> intermediate -> system root)"
