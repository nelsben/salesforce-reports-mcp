#!/usr/bin/env bash
# Deploys the dashboard probe to one org: a report folder with three Opportunity
# reports, a dashboard folder, and the Pipeline Overview dashboard.
#
# Usage: scripts/setup.sh <alias>
#
# The tracked dashboard names its running user as __RUNNING_USER__. This script
# copies the project to a temp folder, fills in the username of the org's CLI
# user there, deploys from there, and deletes the copy. It prints no username.
set -euo pipefail

ALIAS="${1:-}"
if [[ -z "$ALIAS" ]]; then
  echo "Usage: scripts/setup.sh <alias>. Pass the org alias explicitly." >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

USERNAME="$(sf org display -o "$ALIAS" --json | jq -r '.result.username')"
if [[ -z "$USERNAME" || "$USERNAME" == "null" ]]; then
  echo "Could not read the org's username from sf org display." >&2
  exit 1
fi

cp "$HERE/sfdx-project.json" "$WORK/"
cp -R "$HERE/force-app" "$WORK/"
USERNAME="$USERNAME" perl -pi -e 's/__RUNNING_USER__/$ENV{USERNAME}/g' \
  "$WORK/force-app/main/default/dashboards/Dashboard_Probe_Dashboards/Pipeline_Overview.dashboard-meta.xml"

cd "$WORK"
sf project deploy start -d force-app -o "$ALIAS" --wait 10 --ignore-conflicts
