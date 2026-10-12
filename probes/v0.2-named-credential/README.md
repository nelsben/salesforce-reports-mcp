# v0.2 phase 3c probe: a per-user JWT named credential back into the same org

A self-contained SFDX project. It holds everything the probe deployed to `dev-backend`, the scripts that fill in the org's values and deploy them, and the destructive manifests that remove them. Findings are in `docs/probes/v0.2-phase3c.md`.

The question: can Apex call the org's own REST API (the Reports API) as the running user, through a named credential, without `UserInfo.getSessionId()`, without a consumer secret and without a per-user click?

Run every command from this folder. Use a scratch or dev org alias you are allowed to write to, and pass it explicitly. The examples use `dev-backend`. The scripts need `sf`, `jq` and `perl`.

| Component | What it is |
| --- | --- |
| `certs/SalesforceReportsSelf` | A self-signed certificate, 2048-bit, made in the org at deploy time. The private key cannot be exported. The `.crt` file is empty on purpose: a source deploy needs one, and an empty one tells the org to make a new key pair. |
| `externalClientApps/SalesforceReportsSelf` | The probe External Client App |
| `extlClntAppOauthSettings/SalesforceReportsSelf` | Its scopes: `Api, RefreshToken` |
| `extlClntAppGlobalOauthSets/SalesforceReportsSelf` | Its global OAuth settings. `certificate` holds the public certificate, which turns on the JWT bearer flow. It holds no secret. |
| `extlClntAppPolicies/SalesforceReportsSelf` | The app is enabled, with the OAuth plugin on |
| `extlClntAppOauthPolicies/SalesforceReportsSelf` | Admin-approved users are pre-authorized, through the permission set `SalesforceReportsSelf` |
| `externalCredentials/SalesforceReportsSelf` | OAuth, JWT bearer flow, a per-user principal `RunningUser`. The `sub` claim is the formula `{!$User.Username}`. |
| `namedCredentials/SalesforceReportsSelf` | `SecuredEndpoint` on the org's My Domain, through the external credential |
| `permissionsets/SalesforceReportsSelf` | Grants the principal `SalesforceReportsSelf-RunningUser`. The app policy names it, so it also pre-authorizes the user on the app. |

## Placeholders

The tracked files hold placeholders only. `scripts/setup.sh` copies the project to a temp folder, fills these in there, deploys from there and deletes the copy. It prints none of the values.

| Placeholder | File | Filled with |
| --- | --- | --- |
| `__CERTIFICATE__` | `extlClntAppGlobalOauthSets/SalesforceReportsSelf.ecaGlblOauth-meta.xml` | The public certificate, retrieved after the certificate is deployed |
| `__CONSUMER_KEY__` | `externalCredentials/SalesforceReportsSelf.externalCredential-meta.xml` (the `iss` claim) | The app's consumer key, read from `/services/data/v68.0/apps/oauth/credentials/<app id>`. That listing holds the key and no secret. |
| `__MY_DOMAIN__` | the external credential's token URL and the named credential's URL | The org's My Domain host, from `sf org display` |
| `__AUDIENCE__` | the external credential's `aud` claim | `https://<My Domain>`, or the script's second argument |

## Run

1. Red: `sf apex run -f scripts/call.apex -o dev-backend`. Before setup it fails: the named credential does not exist.
2. Set up: `./scripts/setup.sh dev-backend`
3. Assign: `sf org assign permset -n SalesforceReportsSelf -o dev-backend`
4. Green: `sf apex run -f scripts/call.apex -o dev-backend`. It calls `analytics/reportTypes`, `analytics/reports`, `chatter/users/me` and `/services/oauth2/userinfo` through the named credential. It prints each status and the first 200 characters of each report body. For the two identity calls it prints only whether the user they name is the running user. It fails unless both report calls answer 200 and an identity call names the running user.
5. The DML limit: `sf apex run -f scripts/dml-first.apex -o dev-backend`. It inserts an Account, calls out, and always fails on purpose, so the insert is rolled back.

## Clean up

`./scripts/teardown.sh dev-backend` unassigns the permission set, then runs:

```
sf project deploy start --manifest destructive/package.xml --pre-destructive-changes destructive/pre.xml --post-destructive-changes destructive/post.xml --ignore-conflicts -o dev-backend
```

The pre step removes the two app policies, the two app OAuth settings, the named credential and the permission set. The post step removes the external credential, the app and the certificate. The script then counts what is left: every count should be 0.

No org setting is changed by the probe, so none needs turning back off.
