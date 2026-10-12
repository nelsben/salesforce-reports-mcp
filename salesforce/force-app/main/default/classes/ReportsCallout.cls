/**
 * Outbound HTTP adapter layer: the one way the core calls the org's own REST API (phase 3a), URL.getOrgDomainUrl() plus
 * /services/data/v62.0, under the running user's session. Every callout tool goes through send(), so a Named Credential
 * can replace the session here alone: set the endpoint to 'callout:<name>' plus the path, and drop the Authorization
 * header. Phase 0 probe 3 showed this needs no Remote Site Setting. It reads upstream status codes, but it throws only
 * the core's ReportsException, with a category and never a status of its own.
 *
 * The door that calls the core sets calloutIdentity before the call. Under a hosted MCP sign-in, UserInfo.getSessionId()
 * throws an exception no catch block can stop (docs/decisions/0007), so that door sets NONE, and send() refuses with
 * CALLOUT_SESSION before it asks for a session.
 */
public with sharing class ReportsCallout {
    public static final String API_PATH = '/services/data/v62.0';
    public static final String SESSION_HINT = 'The in-org door could not call the org\'s REST API under this sign-in. Use the local server, or ask an admin to give the sign-in API access (docs/probes/v0.2-phase3.md).';
    public static final String HOSTED_MESSAGE = 'The hosted MCP sign-in gives Apex no session to call the org\'s REST API with, so this tool cannot run on the hosted MCP server.';
    public static final String HOSTED_HINT = 'On the hosted MCP server, search_reports, list_report_folders, describe_report, describe_report_type (through a saved report of the type), run_report with overrides and combine_reports over saved reports still work. For list_report_types, query_report, combine_reports with definitions and the save tools, use the local server or the in-org REST door (docs/decisions/0007).';
    /** The longest one synchronous callout may take. */
    static final Integer TIMEOUT_MS = 120000;

    /**
     * Whose identity a callout carries. SESSION is the running user's session. NONE means the caller has no session to
     * use, and send() refuses before it asks for one. A per-user Named Credential would be a third value.
     */
    public enum Identity { SESSION, NONE }

    /** Set by the door for each call. The REST door leaves SESSION, the hosted MCP door sets NONE. */
    public static Identity calloutIdentity = Identity.SESSION;

    /** Tests set this to stand in for a sign-in that has no session. */
    @TestVisible
    static Boolean noSession = false;

    /**
     * Calls `path` (after /services/data/v62.0) and answers with the parsed JSON, or null for an empty body.
     * A refused session throws CALLOUT_SESSION, and so does a call with no identity to use, before any session is asked
     * for and before any request is built. Any other error throws the code, message and hint the local door gives for
     * it (src/salesforce/client.ts and src/format.ts), as invalid input for a 4xx and failed otherwise.
     */
    public static Object send(String method, String path, Object body) {
        if (calloutIdentity == Identity.NONE) throw ReportsException.failed('CALLOUT_SESSION', HOSTED_MESSAGE, HOSTED_HINT);
        String session = session();
        if (String.isBlank(session)) throw refused('There is no session to call the org\'s REST API with.');
        HttpRequest req = new HttpRequest();
        req.setEndpoint(URL.getOrgDomainUrl().toExternalForm().removeEnd('/') + API_PATH + path);
        req.setMethod(method);
        req.setHeader('Authorization', 'Bearer ' + session);
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
            throw ReportsException.failed('CALLOUT_FAILED', 'The in-org door\'s call to ' + method + ' ' + path.substringBefore('?') + ' failed: ' + e.getMessage(),
                'A response over 6 MB, or a call over 120 seconds, fails here. Narrow the filters, drop columns, or use the local server.');
        }
        Integer status = res.getStatusCode();
        String text = res.getBody();
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
        ReportsException.ErrorCategory category = status >= 400 && status < 500 ? ReportsException.ErrorCategory.INVALID_INPUT : ReportsException.ErrorCategory.FAILED;
        return ReportsException.create(category, code, message, status == 404 ? ReportsException.ID_HINT : ReportsException.hintFor(code, message));
    }
}
