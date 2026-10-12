/**
 * REST adapter layer: the in-org REST door (docs/design.md, "v0.2: the in-org doors", and docs/architecture.md).
 * POST /services/apexrest/reports/v1/<tool> takes the local tool's JSON input and answers with the JSON the local tool
 * returns. This class only reads the tool name from the URL and the body text, hands both to ReportsService, and turns
 * the answer into status 200, or a ReportsException into the status of its category (400 invalid input, 403 forbidden,
 * 404 unknown tool, 500 failed) and the error body src/format.ts builds. The tools, the write permission check and the
 * errors live in the core, which never names this class. The hosted MCP door reaches the core through this class too.
 */
@RestResource(urlMapping='/reports/v1/*')
global with sharing class ReportsApi {
    /** The HTTP status of each core error category. */
    static final Map<ReportsException.ErrorCategory, Integer> STATUS = new Map<ReportsException.ErrorCategory, Integer>{
        ReportsException.ErrorCategory.INVALID_INPUT => 400,
        ReportsException.ErrorCategory.FORBIDDEN => 403,
        ReportsException.ErrorCategory.UNKNOWN_TOOL => 404,
        ReportsException.ErrorCategory.FAILED => 500
    };

    /** A status and the body to write as JSON. */
    public class Answer {
        public Integer status;
        public Object body;
        public Answer(Integer status, Object body) {
            this.status = status;
            this.body = body;
        }
    }

    @HttpPost
    global static void post() {
        RestRequest req = RestContext.request;
        Answer answer = handle(req.requestURI.substringAfterLast('/'), req.requestBody == null ? null : req.requestBody.toString());
        RestResponse res = RestContext.response;
        res.statusCode = answer.status;
        res.addHeader('Content-Type', 'application/json');
        res.responseBody = Blob.valueOf(JSON.serialize(answer.body));
    }

    /** One call of a tool: 200 with the tool's answer, or the failure's status and error body. */
    public static Answer handle(String tool, String body) {
        try {
            return new Answer(200, ReportsService.call(tool, body));
        } catch (Exception e) {
            return failure(e);
        }
    }

    /** A failure as status and body: {"error": {"code", "message", "hint"?}}, as src/format.ts builds it. */
    public static Answer failure(Exception e) {
        ReportsException error = ReportsException.fromException(e);
        return new Answer(STATUS.get(error.category), errorBody(error.code, error.getMessage(), error.hintText));
    }

    static Map<String, Object> errorBody(String code, String message, String hintText) {
        Map<String, Object> error = new Map<String, Object>{ 'code' => code, 'message' => message };
        if (hintText != null) error.put('hint', hintText);
        return new Map<String, Object>{ 'error' => error };
    }
}
