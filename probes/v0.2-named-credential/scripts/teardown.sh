#!/usr/bin/env bash
# Removes every probe component from one org, then lists what is left.
#
# Usage: scripts/teardown.sh <alias>
#
# An assigned permission set cannot be deleted, so the assignments go first.
set -euo pipefail

ALIAS="${1:-}"
if [[ -z "$ALIAS" ]]; then
  echo "Usage: scripts/teardown.sh <alias>. Pass the org alias explicitly." >&2
  exit 2
fi
cd "$(dirname "$0")/.."

echo "1. Unassign the probe permission set."
for id in $(sf data query -q "SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = 'SalesforceReportsSelf'" \
  -o "$ALIAS" --json | jq -r '.result.records[].Id'); do
  sf data delete record -s PermissionSetAssignment -i "$id" -o "$ALIAS" > /dev/null
done

echo "2. Delete the components: policies, settings, named credential and permission set first, then the rest."
sf project deploy start --manifest destructive/package.xml --pre-destructive-changes destructive/pre.xml \
  --post-destructive-changes destructive/post.xml --ignore-conflicts -o "$ALIAS" --wait 10 > /dev/null

echo "3. What is left (each count should be 0)."
for q in \
  "SELECT COUNT() FROM ExternalClientApplication WHERE DeveloperName = 'SalesforceReportsSelf'" \
  "SELECT COUNT() FROM NamedCredential WHERE DeveloperName = 'SalesforceReportsSelf'" \
  "SELECT COUNT() FROM PermissionSet WHERE Name = 'SalesforceReportsSelf'"; do
  echo "$q: $(sf data query -q "$q" -o "$ALIAS" --json | jq -r '.result.totalSize')"
done
for t in Certificate ExternalCredential; do
  echo "$t SalesforceReportsSelf: $(sf org list metadata -m "$t" -o "$ALIAS" --json | jq '[.result[]? | select(.fullName == "SalesforceReportsSelf")] | length')"
done
