/**
 * The one way the in-org door calls the org's own REST API (phase 3a): URL.getOrgDomainUrl() plus /services/data/v62.0,
 * under the running user's session. Every callout tool goes through send(), so a Named Credential can replace the
 * session here alone: set the endpoint to 'callout:<name>' plus the path, and drop the Authorization header.
 * Phase 0 probe 3 showed this needs no Remote Site Setting.
 */
public with sharing class ReportsCallout {
    public static final String API_PATH = '/services/data/v62.0';
    public static final String SESSION_HINT = 'The in-org door could not call the org\'s REST API under this sign-in. Use the local server, or ask an admin to give the sign-in API access (docs/probes/v0.2-phase3.md).';
    /** The longest one synchronous callout may take. */
    static final Integer TIMEOUT_MS = 120000;

    /** Tests set this to stand in for a sign-in that has no session. */
    @TestVisible
    static Boolean noSession = false;

    /**
     * Calls `path` (after /services/data/v62.0) and answers with the parsed JSON, or null for an empty body.
     * A refused session throws CALLOUT_SESSION. Any other error throws the code, message and hint the local door
     * gives for it (src/salesforce/client.ts and src/format.ts), with status 400 for a 4xx and 500 otherwise.
     */
    public static Object send(String method, String path, Object body) {
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
            throw ReportsApi.apiError(500, 'CALLOUT_FAILED', 'The in-org door\'s call to ' + method + ' ' + path.substringBefore('?') + ' failed: ' + e.getMessage(),
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

    static ReportsApi.ApiException refused(String message) {
        return ReportsApi.apiError(500, 'CALLOUT_SESSION', message, SESSION_HINT);
    }

    /** As src/salesforce/client.ts toError reads a Salesforce error body, then as src/format.ts describes it. */
    @TestVisible
    static ReportsApi.ApiException toError(Integer status, String text, String call) {
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
        return ReportsApi.apiError(status >= 400 && status < 500 ? 400 : 500, code, message, ReportsApi.hintFor(status, code, message));
    }
}
