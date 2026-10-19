/**
 * Outbound HTTP adapter layer: the one way the core calls the org's own REST API (phase 3a), /services/data/v62.0 on
 * the org's own domain. Every callout tool goes through send(), so the identity a call carries is chosen here alone.
 * Phase 0 probe 3 showed a session callout needs no Remote Site Setting. It reads upstream status codes, but it throws
 * only the core's ReportsException, with a category and never a status of its own.
 *
 * The door that calls the core sets calloutIdentity before the call. The REST door sets SESSION: the running user's
 * session, from URL.getOrgDomainUrl(). Under a hosted MCP sign-in, UserInfo.getSessionId() throws an exception no catch
 * block can stop (docs/decisions/0007), so the hosted door sets NAMED_CREDENTIAL and send() never asks for a session.
 * When the optional callout-app package is installed, the call goes to callout:SalesforceReportsCallout, whose
 * per-user JWT credential mints a token for the running user and adds the Authorization header (docs/decisions/0012).
 * When it is not installed, send() refuses with CALLOUT_SESSION before any request, as NONE does. A user without the
 * callout permission set gets CALLOUT_CREDENTIAL, with a hint naming the set. Nothing in force-app depends on that
 * package: the credential is named only in strings, and its presence is read at run time.
 */
public with sharing class ReportsCallout {
    public static final String API_PATH = '/services/data/v62.0';
    /** The named credential in salesforce/callout-app, and the permission set that grants its per-user principal. */
    public static final String CREDENTIAL = 'SalesforceReportsCallout';
    public static final String CREDENTIAL_PERMISSION_SET = 'Salesforce_Reports_Callout';
    public static final String SESSION_HINT = 'The in-org door could not call the org\'s REST API under this sign-in. Use the local server, or ask an admin to give the sign-in API access (docs/probes/v0.2-phase3.md).';
    public static final String HOSTED_MESSAGE = 'The hosted MCP sign-in gives Apex no session to call the org\'s REST API with, so this tool cannot run on the hosted MCP server.';
    public static final String HOSTED_HINT = 'On the hosted MCP server, search_reports, list_report_folders, describe_report, describe_report_type (through a saved report of the type), run_report with overrides and combine_reports over saved reports still work. For list_report_types, query_report, combine_reports with definitions and the save tools, use the local server or the in-org REST door (docs/decisions/0007).';
    public static final String CREDENTIAL_HINT = 'Ask an admin to assign the permission set ' + CREDENTIAL_PERMISSION_SET + ' to this user. It lets the hosted MCP server call the org\'s REST API as the user, through the named credential ' + CREDENTIAL + ' (docs/decisions/0012).';
    public static final String CREDENTIAL_SETUP_HINT = 'The named credential ' + CREDENTIAL + ' could not mint a token for this user. Ask an admin to run the callout setup again (salesforce/README.md) and to check that the user has the permission set ' + CREDENTIAL_PERMISSION_SET + '.';
    /** The code of the once-a-minute refresh refusal: a 403 on the dashboard refresh PUT. ReportsDashboards turns it into a note. */
    public static final String REFRESH_LIMIT = 'REFRESH_LIMIT';
    /** The longest one synchronous callout may take. */
    static final Integer TIMEOUT_MS = 120000;

    /**
     * Whose identity a callout carries. SESSION is the running user's session. NAMED_CREDENTIAL is the running user
     * through the per-user named credential CREDENTIAL, when it is installed, and never asks for a session. NONE means
     * the caller has no identity to use, and send() refuses before any request.
     */
    public enum Identity { SESSION, NAMED_CREDENTIAL, NONE }

    /** Set by the door for each call. The REST door leaves SESSION, the hosted MCP door sets NAMED_CREDENTIAL. */
    public static Identity calloutIdentity = Identity.SESSION;

    /** Tests set this to stand in for a sign-in that has no session. */
    @TestVisible
    static Boolean noSession = false;

    /** Whether the named credential CREDENTIAL is in the org. Read once per transaction; tests set it. */
    @TestVisible
    static Boolean credentialInstalled;

    /** Messages Salesforce gives when a named credential callout cannot get a token for the user (phase 3c). */
    static final List<String> CREDENTIAL_ACCESS = new List<String>{ 'We couldn\'t access the credential', 'might not exist' };
    static final String TOKEN_EXCHANGE = 'Unable to complete the JWT token exchange';

    /**
     * Calls `path` (after /services/data/v62.0) and answers with the parsed JSON, or null for an empty body.
     * A refused session throws CALLOUT_SESSION, and so does a call with no identity to use (NONE, or NAMED_CREDENTIAL
     * without the credential installed), before any session is asked for and before any request is built. A named
     * credential the user cannot use throws CALLOUT_CREDENTIAL. Any other error throws the code, message and hint the
     * local door gives for it (src/salesforce/client.ts and src/format.ts), as invalid input for a 4xx and failed otherwise.
     */
    public static Object send(String method, String path, Object body) {
        Boolean throughCredential = calloutIdentity == Identity.NAMED_CREDENTIAL && hasCredential();
        if (calloutIdentity != Identity.SESSION && !throughCredential) throw ReportsException.failed('CALLOUT_SESSION', HOSTED_MESSAGE, HOSTED_HINT);
        HttpRequest req = new HttpRequest();
        if (throughCredential) {
            // The credential adds the Authorization header with a token it mints for the running user.
            req.setEndpoint('callout:' + CREDENTIAL + API_PATH + path);
        } else {
            String session = session();
            if (String.isBlank(session)) throw refused('There is no session to call the org\'s REST API with.');
            req.setEndpoint(URL.getOrgDomainUrl().toExternalForm().removeEnd('/') + API_PATH + path);
            req.setHeader('Authorization', 'Bearer ' + session);
        }
        req.setMethod(method);
        req.setHeader('Accept', 'application/json');
        req.setTimeout(TIMEOUT_MS);
        if (body != null) {
            req.setHeader('Content-Type', 'application/json');
            req.setBody(JSON.serialize(body));
        }
        HttpResponse res;
        try {
            res = new Http().send(req);
        } catch (CalloutException e) {
            if (throughCredential) {
                ReportsException credential = credentialError(e.getMessage());
                if (credential != null) throw credential;
            }
            throw ReportsException.failed('CALLOUT_FAILED', 'The in-org door\'s call to ' + method + ' ' + path.substringBefore('?') + ' failed: ' + e.getMessage(),
                'A response over 6 MB, or a call over 120 seconds, fails here. Narrow the filters, drop columns, or use the local server.');
        }
        Integer status = res.getStatusCode();
        String text = res.getBody();
        if (throughCredential && status == 401) {
            throw ReportsException.failed('CALLOUT_CREDENTIAL', 'Salesforce refused the token the named credential ' + CREDENTIAL + ' minted for ' + method + ' ' + path.substringBefore('?') + '.', CREDENTIAL_SETUP_HINT);
        }
        if (status < 200 || status >= 300) throw toError(status, text, method + ' ' + path.substringBefore('?'));
        if (String.isBlank(text)) return null;
        // The body costs about 2 bytes of heap per character and parsing about 1 more (phase 3a), and Apex cannot
        // catch the heap limit, so stop with the error shape before parsing a body that would not fit.
        if (Limits.getHeapSize() + text.length() > Limits.getLimitHeapSize() * 0.8) throw ReportsShape.tooLarge();
        return JSON.deserializeUntyped(text);
    }

    /** A path segment, as encodeURIComponent writes it for a report type or id. */
    public static String segment(String value) {
        return EncodingUtil.urlEncode(value, 'UTF-8').replace('+', '%20');
    }

    /** Whether the named credential is in the org: a setup query in system mode, so a user without View Setup sees it. */
    @TestVisible
    static Boolean hasCredential() {
        if (credentialInstalled == null) {
            credentialInstalled = [SELECT COUNT() FROM NamedCredential WHERE DeveloperName = :CREDENTIAL] > 0;
        }
        return credentialInstalled;
    }

    /**
     * A named credential callout that could not get a token, as CALLOUT_CREDENTIAL, or null for any other failure.
     * A user without the permission set gets a hint to assign it. A failed token exchange keeps Salesforce's text,
     * since it names the setup fault (phase 3c).
     */
    @TestVisible
    static ReportsException credentialError(String message) {
        String text = message == null ? '' : message;
        if (text.contains(TOKEN_EXCHANGE)) {
            return ReportsException.failed('CALLOUT_CREDENTIAL', 'The named credential ' + CREDENTIAL + ' could not get a token for this user: ' + text, CREDENTIAL_SETUP_HINT);
        }
        for (String marker : CREDENTIAL_ACCESS) {
            if (text.contains(marker)) {
                return ReportsException.failed('CALLOUT_CREDENTIAL', 'This user cannot use the named credential ' + CREDENTIAL + ', so the hosted MCP server cannot call the org\'s REST API as them: ' + text, CREDENTIAL_HINT);
            }
        }
        return null;
    }

    static String session() {
        if (noSession) return null;
        String id = UserInfo.getSessionId();
        // A test run can have no session of its own; its callouts are mocked.
        return id == null && Test.isRunningTest() ? 'test-session' : id;
    }

    static ReportsException refused(String message) {
        return ReportsException.failed('CALLOUT_SESSION', message, SESSION_HINT);
    }

    /** As src/salesforce/client.ts toError reads a Salesforce error body, then as src/format.ts describes it. */
    @TestVisible
    static ReportsException toError(Integer status, String text, String call) {
        String code = 'HTTP_' + status;
        String message = 'Salesforce returned HTTP ' + status + '.';
        try {
            Object parsed = JSON.deserializeUntyped(text);
            Object first = parsed;
            if (parsed instanceof List<Object>) first = ((List<Object>) parsed).isEmpty() ? null : ((List<Object>) parsed)[0];
            if (first instanceof Map<String, Object>) {
                Map<String, Object> f = (Map<String, Object>) first;
                Object c = f.get('errorCode') != null ? f.get('errorCode') : f.get('error');
                Object m = f.get('message') != null ? f.get('message') : f.get('error_description');
                code = c != null ? String.valueOf(c) : code;
                message = m != null ? String.valueOf(m) : 'HTTP ' + status;
            }
        } catch (Exception e) {
            // not JSON: keep the HTTP status
        }
        if (status == 401 || code == 'INVALID_SESSION_ID') {
            return refused('Salesforce refused the session for ' + call + ' (' + status + ' ' + code + ': ' + message + ').');
        }
        // src/reports/dashboards.ts isRefreshLimit: 403 with code FORBIDDEN, or the word "minute" in the message.
        if (status == 403 && call.startsWith('PUT /analytics/dashboards/') && (code == 'FORBIDDEN' || message.containsIgnoreCase('minute'))) {
            return ReportsException.create(ReportsException.ErrorCategory.INVALID_INPUT, REFRESH_LIMIT, message, null);
        }
        ReportsException.ErrorCategory category = status >= 400 && status < 500 ? ReportsException.ErrorCategory.INVALID_INPUT : ReportsException.ErrorCategory.FAILED;
        return ReportsException.create(category, code, message, status == 404 ? ReportsException.ID_HINT : ReportsException.hintFor(code, message));
    }
}
