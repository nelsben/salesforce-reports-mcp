#!/usr/bin/env bash
# Deploys the named credential probe to one org.
#
# Usage: scripts/setup.sh <alias> [audience]
#
# The tracked files hold placeholders only. This script copies the project to a
# temp folder, fills the org's values in there, deploys from there, and deletes
# the copy. It fills:
#   __CERTIFICATE__   the public part of the self-signed certificate it deploys
#   __MY_DOMAIN__     the org's My Domain host, from `sf org display`
#   __CONSUMER_KEY__  the probe External Client App's consumer key (a client id)
#   __AUDIENCE__      the JWT aud claim: the second argument, or https://<My Domain>
# It never reads a consumer secret, a token or a private key, and prints none
# of the filled values.
set -euo pipefail

ALIAS="${1:-}"
if [[ -z "$ALIAS" ]]; then
  echo "Usage: scripts/setup.sh <alias> [audience]. Pass the org alias explicitly." >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

MY_DOMAIN="$(sf org display -o "$ALIAS" --json | jq -r '.result.instanceUrl' | sed -e 's|^https://||' -e 's|/$||')"
if [[ -z "$MY_DOMAIN" || "$MY_DOMAIN" == "null" ]]; then
  echo "Could not read the org's My Domain from sf org display." >&2
  exit 1
fi
AUDIENCE="${2:-https://$MY_DOMAIN}"

cp "$HERE/sfdx-project.json" "$WORK/"
cp -R "$HERE/force-app" "$WORK/"
cd "$WORK"
SRC="force-app/main/default"

echo "1. Certificate: a self-signed key pair made in the org. The private key never leaves it."
sf project deploy start -d "$SRC/certs" --ignore-conflicts -o "$ALIAS" --wait 10 > /dev/null

echo "2. Read back the public certificate."
sf project retrieve start -m "Certificate:SalesforceReportsSelf" -o "$ALIAS" \
  --target-metadata-dir "$WORK/cert" --unzip > /dev/null
CERT_FILE="$(find "$WORK/cert" -name 'SalesforceReportsSelf.crt' | head -1)"
if [[ ! -s "$CERT_FILE" ]] || ! grep -q 'BEGIN CERTIFICATE' "$CERT_FILE"; then
  echo "The retrieved certificate is empty." >&2
  exit 1
fi
CERT_FILE="$CERT_FILE" perl -0pi -e '
  open my $f, "<", $ENV{CERT_FILE} or die; local $/; my $c = <$f>; $c =~ s/\s+$//;
  s/__CERTIFICATE__/$c/g' "$SRC/extlClntAppGlobalOauthSets/SalesforceReportsSelf.ecaGlblOauth-meta.xml"

echo "3. External Client App, with the certificate for the JWT bearer flow."
sf project deploy start -d "$SRC/externalClientApps" -d "$SRC/extlClntAppOauthSettings" \
  -d "$SRC/extlClntAppGlobalOauthSets" -d "$SRC/extlClntAppPolicies" --ignore-conflicts -o "$ALIAS" --wait 10 > /dev/null

echo "4. Read the app's consumer key (a client id, not a secret)."
APP_ID="$(sf data query -q "SELECT Id FROM ExternalClientApplication WHERE DeveloperName = 'SalesforceReportsSelf'" \
  -o "$ALIAS" --json | jq -r '.result.records[0].Id')"
CONSUMER_KEY="$(sf api request rest "/services/data/v68.0/apps/oauth/credentials/$APP_ID" -o "$ALIAS" 2>/dev/null \
  | jq -r '.consumers[0].key')"
if [[ -z "$CONSUMER_KEY" || "$CONSUMER_KEY" == "null" ]]; then
  echo "Could not read the consumer key." >&2
  exit 1
fi

MY_DOMAIN="$MY_DOMAIN" CONSUMER_KEY="$CONSUMER_KEY" AUDIENCE="$AUDIENCE" perl -pi -e '
  s/__MY_DOMAIN__/$ENV{MY_DOMAIN}/g; s/__CONSUMER_KEY__/$ENV{CONSUMER_KEY}/g; s/__AUDIENCE__/$ENV{AUDIENCE}/g' \
  "$SRC/externalCredentials/SalesforceReportsSelf.externalCredential-meta.xml" \
  "$SRC/namedCredentials/SalesforceReportsSelf.namedCredential-meta.xml"

echo "5. External credential, named credential and permission set."
sf project deploy start -d "$SRC/externalCredentials" -d "$SRC/namedCredentials" \
  -d "$SRC/permissionsets" --ignore-conflicts -o "$ALIAS" --wait 10 > /dev/null

echo "6. App policy: users with the permission set are pre-authorized."
sf project deploy start -d "$SRC/extlClntAppOauthPolicies" --ignore-conflicts -o "$ALIAS" --wait 10 > /dev/null

echo "Done. Next: sf org assign permset -n SalesforceReportsSelf -o $ALIAS"
echo "Then: sf apex run -f scripts/call.apex -o $ALIAS"
