/**
 * The in-org REST door for the runner tools (docs/design.md, "v0.2: the in-org doors").
 * POST /services/apexrest/reports/v1/<tool> takes the local tool's JSON input and answers with the JSON
 * the local tool returns. A failure answers 400 (bad input) or 500 with the body the local fail() builds,
 * and a tool this door lacks answers 404. Ported from src/server.ts and src/format.ts.
 */
@RestResource(urlMapping='/reports/v1/*')
global with sharing class ReportsApi {
    public static final Integer DEFAULT_MAX_ROWS = 200;
    static final List<String> TOOLS = new List<String>{
        'search_reports', 'list_report_folders', 'describe_report', 'describe_report_type', 'run_report', 'combine_reports'
    };
    static final Set<String> LATER = new Set<String>{
        'list_report_types', 'query_report', 'create_report', 'update_report', 'clone_report', 'delete_report'
    };
    static final String OPERATOR_NOTE = 'Filter operators are not on the in-org door, because Apex does not expose them. Common ones: equals, notEqual, lessThan, greaterThan, lessOrEqual, greaterOrEqual, contains, notContain, startsWith, includes, excludes.';

    /** A failure with its HTTP status, error code and optional hint. */
    public class ApiException extends Exception {
        public Integer status = 400;
        public String code = 'INVALID_INPUT';
        public String hintText;
    }

    public class Answer {
        public Integer status;
        public Object body;
        public Answer(Integer status, Object body) {
            this.status = status;
            this.body = body;
        }
    }

    public static ApiException inputError(String message) {
        return apiError(400, 'INVALID_INPUT', message, null);
    }

    public static ApiException apiError(Integer status, String code, String message, String hintText) {
        ApiException e = new ApiException(message);
        e.status = status;
        e.code = code;
        e.hintText = hintText;
        return e;
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

    public static Answer handle(String tool, String body) {
        if (!TOOLS.contains(tool)) {
            String message = LATER.contains(tool)
                ? tool + ' is not on the in-org door yet. Use the local server for it.'
                : 'There is no tool named "' + tool + '". This door offers ' + String.join(TOOLS, ', ') + '.';
            return new Answer(404, errorBody('UNKNOWN_TOOL', message, null));
        }
        try {
            return new Answer(200, dispatch(tool, parse(body)));
        } catch (Exception e) {
            return failure(e);
        }
    }

    static Object dispatch(String tool, Map<String, Object> input) {
        switch on tool {
            when 'search_reports' {
                return searchReports(input);
            }
            when 'list_report_folders' {
                return listReportFolders(input);
            }
            when 'describe_report' {
                return describeReport(input);
            }
            when 'describe_report_type' {
                return describeReportType(input);
            }
            when 'run_report' {
                return runToResult(reportId(input, 'reportId'), optMap(input, 'overrides'), optBool(input, 'detail'), optInt(input, 'maxRows', 1, ReportsShape.HARD_ROW_CEILING));
            }
            when else {
                return combineReports(input);
            }
        }
    }

    // ---- tools ----

    static Map<String, Object> searchReports(Map<String, Object> input) {
        String query = optString(input, 'query');
        String folder = optString(input, 'folder');
        String format = optString(input, 'format');
        Integer lim = optInt(input, 'limit', 1, 200);
        Map<String, String> formats = new Map<String, String>{ 'TABULAR' => 'Tabular', 'SUMMARY' => 'Summary', 'MATRIX' => 'Matrix', 'JOINED' => 'MultiBlock' };
        if (format != null && !formats.containsKey(format)) throw inputError('format must be TABULAR, SUMMARY, MATRIX or JOINED.');
        List<String> conditions = new List<String>();
        if (String.isNotEmpty(query)) conditions.add('(Name LIKE \'%' + soqlLike(query) + '%\' OR DeveloperName LIKE \'%' + soqlLike(query) + '%\')');
        if (String.isNotEmpty(folder)) conditions.add('FolderName LIKE \'%' + soqlLike(folder) + '%\'');
        if (format != null) conditions.add('Format = \'' + formats.get(format) + '\'');
        String soql = 'SELECT Id, Name, DeveloperName, FolderName, Format, Description, LastRunDate, LastModifiedDate FROM Report'
            + (conditions.isEmpty() ? '' : ' WHERE ' + String.join(conditions, ' AND '))
            + ' ORDER BY LastModifiedDate DESC LIMIT ' + (lim == null ? 25 : lim);
        String base = baseUrl();
        List<Object> found = new List<Object>();
        for (Report r : (List<Report>) Database.query(soql, AccessLevel.USER_MODE)) {
            found.add(new Map<String, Object>{
                'id' => r.Id,
                'name' => r.Name,
                'developerName' => r.DeveloperName,
                'folder' => r.FolderName,
                'format' => r.Format,
                'description' => r.Description,
                'lastRunDate' => soqlDatetime(r.LastRunDate),
                'lastModifiedDate' => soqlDatetime(r.LastModifiedDate),
                'url' => ReportsSummary.reportUrl(base, r.Id)
            });
        }
        return new Map<String, Object>{ 'count' => found.size(), 'reports' => found };
    }

    static Map<String, Object> listReportFolders(Map<String, Object> input) {
        String search = optString(input, 'search');
        Integer lim = optInt(input, 'limit', 1, 200);
        List<String> conditions = new List<String>{ 'Type = \'Report\'', 'AccessType != \'Hidden\'' };
        if (String.isNotEmpty(search)) conditions.add('Name LIKE \'%' + soqlLike(search) + '%\'');
        String soql = 'SELECT Id, Name, DeveloperName, AccessType FROM Folder WHERE ' + String.join(conditions, ' AND ')
            + ' ORDER BY Name LIMIT ' + (lim == null ? 100 : lim);
        List<Object> folders = new List<Object>();
        // The org-wide Public Reports folder is not a Folder row; its id is the org id.
        if (String.isEmpty(search) || 'public reports'.contains(search.toLowerCase())) {
            folders.add(new Map<String, Object>{
                'id' => UserInfo.getOrganizationId(),
                'name' => 'Public Reports',
                'developerName' => 'unfiled$public',
                'accessType' => 'Public'
            });
        }
        for (Folder f : (List<Folder>) Database.query(soql, AccessLevel.USER_MODE)) {
            folders.add(new Map<String, Object>{ 'id' => f.Id, 'name' => f.Name, 'developerName' => f.DeveloperName, 'accessType' => f.AccessType });
        }
        return new Map<String, Object>{
            'count' => folders.size(),
            'folders' => folders,
            'note' => 'A report saved with no folderId goes to the user\'s Private Reports folder.'
        };
    }

    static Map<String, Object> describeReport(Map<String, Object> input) {
        Id id = reportId(input, 'reportId');
        Boolean includeMetadata = optBool(input, 'includeMetadata') == true;
        Reports.ReportDescribeResult described = Reports.ReportManager.describeReport(id);
        Map<String, Object> meta = ReportsSummary.metadataMap(described.getReportMetadata());
        // Apex ReportMetadata has no folderId. A report's OwnerId is its folder, as REST reports it.
        List<Report> rows = [SELECT OwnerId FROM Report WHERE Id = :id WITH USER_MODE];
        meta.put('folderId', rows.isEmpty() ? null : (String) rows[0].OwnerId);
        Map<String, Object> summary = ReportsSummary.summarizeReport(meta, ReportsSummary.infoMaps(described.getReportExtendedMetadata()), baseUrl(), includeMetadata);
        summary.put('folder', folderInfo((String) summary.get('folderId')));
        return summary;
    }

    static Map<String, Object> describeReportType(Map<String, Object> input) {
        String type = reqString(input, 'type');
        String search = optString(input, 'search');
        Integer lim = optInt(input, 'limit', 1, 1000);
        // Apex reads a report type only through a saved report of that type (phase 0, probe 5).
        // Report.ReportTypeApiName can carry a suffix, for example Opportunity@Opportunity.Some_Lookup__c, and SOQL
        // does not filter on it, so scan the most recently modified reports and match the name or its prefix.
        Integer tried = 0;
        for (Report candidate : [SELECT Id, ReportTypeApiName FROM Report WITH USER_MODE ORDER BY LastModifiedDate DESC LIMIT 10000]) {
            String apiName = candidate.ReportTypeApiName;
            if (apiName == null || !(apiName.equalsIgnoreCase(type) || apiName.toLowerCase().startsWith(type.toLowerCase() + '@'))) continue;
            if (++tried > 5) break;
            Reports.ReportDescribeResult described = Reports.ReportManager.describeReport(candidate.Id);
            Reports.ReportType reportType = described.getReportMetadata().getReportType();
            if (reportType == null || !type.equalsIgnoreCase(reportType.getType())) continue;
            Map<String, Object> out = ReportsSummary.summarizeReportType(described.getReportTypeMetadata(), reportType.getLabel(), type, search, lim);
            out.put('notes', new List<String>{ OPERATOR_NOTE });
            return out;
        }
        throw apiError(400, 'NO_SAVED_REPORT',
            'The in-org door reads a report type through a saved report of that type, and this user can see no report of type "' + type + '".',
            'Save a report of this type first, or use the local server, which reads the type directly.');
    }

    static Map<String, Object> combineReports(Map<String, Object> input) {
        String mode = reqString(input, 'mode');
        if (mode != 'stack' && mode != 'join') throw inputError('mode must be stack or join.');
        List<Object> inputs = optList(input, 'inputs');
        if (inputs == null || inputs.size() < 2 || inputs.size() > 5) throw inputError('inputs takes 2 to 5 reports.');
        List<String> joinOn = optStringList(input, 'joinOn');
        Boolean detail = optBool(input, 'detail');
        Integer maxRows = optInt(input, 'maxRows', 1, ReportsShape.HARD_ROW_CEILING);
        List<String> aliases = new List<String>();
        List<Id> ids = new List<Id>();
        List<Map<String, Object>> overrides = new List<Map<String, Object>>();
        for (Object o : inputs) {
            Map<String, Object> item = asMap(o, 'inputs');
            String alias = reqString(item, 'alias');
            if (alias == '') throw inputError('Each input needs an alias.');
            if ((item.get('reportId') != null) == (item.get('definition') != null)) {
                throw inputError('Input "' + alias + '" needs exactly one of reportId and definition.');
            }
            if (item.get('definition') != null) {
                throw inputError('Input "' + alias + '" is a definition, which runs through query_report. query_report is not on the in-org door yet, so give a reportId, or use the local server.');
            }
            aliases.add(alias);
            ids.add(reportId(item, 'reportId'));
            overrides.add(optMap(item, 'overrides'));
        }
        List<Map<String, Object>> results = new List<Map<String, Object>>();
        for (Integer i = 0; i < ids.size(); i++) results.add(runToResult(ids[i], overrides[i], detail, maxRows));
        return ReportsCombine.combineResults(mode, aliases, results, joinOn);
    }

    /** run_report's core, shared with combine_reports. */
    public static Map<String, Object> runToResult(Id reportId, Map<String, Object> overrides, Boolean detail, Integer maxRows) {
        List<String> notes = new List<String>();
        Boolean wantsDetail = detail != false;
        Reports.ReportResults results;
        if (overrides != null) {
            ReportsDefinition.Mapped mapped = ReportsDefinition.toReportMetadata(overrides, true);
            notes.addAll(mapped.notes);
            Reports.ReportMetadata metadata = Reports.ReportManager.describeReport(reportId).getReportMetadata();
            ReportsDefinition.applyTo(metadata, mapped.metadata);
            results = Reports.ReportManager.runReport(reportId, metadata, wantsDetail);
        } else {
            results = Reports.ReportManager.runReport(reportId, wantsDetail);
        }
        ReportsShape.guardHeap();
        Boolean tabular = results.getReportMetadata().getReportFormat() == Reports.ReportFormat.TABULAR;
        Integer limitRows = Math.min(maxRows == null ? DEFAULT_MAX_ROWS : maxRows, ReportsShape.HARD_ROW_CEILING);
        return ReportsShape.shapeResult(results, limitRows, detail != null ? detail : tabular, baseUrl(), notes);
    }

    static Map<String, Object> folderInfo(String id) {
        if (String.isEmpty(id)) return null;
        // A private report's folder id is its owner's user id; the org-wide Public Reports folder's id is the org id.
        if (id.startsWith('005')) return folder(id, 'Private Reports', null, true);
        if (id.startsWith('00D')) return folder(id, 'Public Reports', 'unfiled$public', false);
        try {
            List<Folder> rows = [SELECT Id, Name, DeveloperName FROM Folder WHERE Id = :id WITH USER_MODE];
            if (!rows.isEmpty()) return folder(id, rows[0].Name, rows[0].DeveloperName, false);
        } catch (Exception e) {
            // the folder exists but this user cannot read it
        }
        return folder(id, null, null, false);
    }

    static Map<String, Object> folder(String id, String name, String developerName, Boolean isPrivate) {
        return new Map<String, Object>{ 'id' => id, 'name' => name, 'developerName' => developerName, 'isPrivate' => isPrivate };
    }

    // ---- errors, as src/format.ts builds them ----

    public static Answer failure(Exception e) {
        if (e instanceof ApiException) {
            ApiException a = (ApiException) e;
            return new Answer(a.status, errorBody(a.code, a.getMessage(), a.hintText));
        }
        if (e instanceof ReportsCombine.CombineException) return new Answer(400, errorBody('INVALID_INPUT', e.getMessage(), null));
        String type = e.getTypeName();
        if (type.startsWithIgnoreCase('Reports.')) {
            String code = type.substringAfter('.').removeEnd('Exception').replaceAll('([a-z])([A-Z])', '$1_$2').toUpperCase();
            return new Answer(400, errorBody(code, e.getMessage(), hintFor(400, code, e.getMessage())));
        }
        if (e instanceof JSONException || e instanceof StringException || e instanceof TypeException) {
            return new Answer(400, errorBody('INVALID_INPUT', e.getMessage(), null));
        }
        if (e instanceof NoAccessException) {
            return new Answer(500, errorBody('INSUFFICIENT_ACCESS', e.getMessage(), hintFor(500, 'INSUFFICIENT_ACCESS', e.getMessage())));
        }
        return new Answer(500, errorBody('UNEXPECTED', String.isEmpty(e.getMessage()) ? 'Unexpected error.' : e.getMessage(), null));
    }

    static Map<String, Object> errorBody(String code, String message, String hintText) {
        Map<String, Object> error = new Map<String, Object>{ 'code' => code, 'message' => message };
        if (hintText != null) error.put('hint', hintText);
        return new Map<String, Object>{ 'error' => error };
    }

    @TestVisible
    static String hintFor(Integer status, String code, String message) {
        String text = code + ' ' + message;
        if (status == 404 || Pattern.compile('(?i)NOT_FOUND|INVALID_ID').matcher(code).find()) {
            return 'Check the id with search_reports (reports) or list_report_types (report types).';
        }
        if (Pattern.compile('(?i)column|field|grouping|aggregate|filter|operator').matcher(text).find()) {
            return 'Check column API names, filter operators and aggregates with describe_report_type, or the report\'s own columns with describe_report.';
        }
        if (Pattern.compile('(?i)REQUEST_LIMIT_EXCEEDED|limit').matcher(text).find()) {
            return 'Salesforce allows 500 synchronous report runs per org per hour. Wait, or reduce the number of runs.';
        }
        if (Pattern.compile('(?i)INSUFFICIENT_ACCESS|FORBIDDEN|permission').matcher(text).find()) {
            return 'The authenticated user lacks access. They need the Run Reports permission, and for saving, Create and Customize Reports.';
        }
        return null;
    }

    // ---- input ----

    static Map<String, Object> parse(String body) {
        if (String.isBlank(body)) return new Map<String, Object>();
        Object parsed;
        try {
            parsed = JSON.deserializeUntyped(body);
        } catch (JSONException e) {
            throw inputError('The request body is not JSON.');
        }
        return asMap(parsed, 'The request body');
    }

    public static Map<String, Object> asMap(Object value, String what) {
        if (value instanceof Map<String, Object>) return (Map<String, Object>) value;
        throw inputError(what + ' must be a JSON object.');
    }

    public static String optString(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (v == null) return null;
        if (v instanceof String) return (String) v;
        throw inputError(key + ' must be a string.');
    }

    public static String reqString(Map<String, Object> m, String key) {
        String v = optString(m, key);
        if (v == null) throw inputError(key + ' is required.');
        return v;
    }

    public static Boolean optBool(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (v == null) return null;
        if (v instanceof Boolean) return (Boolean) v;
        throw inputError(key + ' must be true or false.');
    }

    public static Integer optInt(Map<String, Object> m, String key, Integer min, Integer max) {
        Object v = m.get(key);
        if (v == null) return null;
        Decimal d;
        if (v instanceof Integer) d = (Integer) v;
        else if (v instanceof Long) d = (Long) v;
        else if (v instanceof Decimal) d = (Decimal) v;
        if (d == null || d != d.round(System.RoundingMode.DOWN) || d < min || d > max) {
            throw inputError(key + ' must be a whole number from ' + min + ' to ' + max + '.');
        }
        return d.intValue();
    }

    public static Map<String, Object> optMap(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v == null ? null : asMap(v, key);
    }

    public static List<Object> optList(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (v == null) return null;
        if (v instanceof List<Object>) return (List<Object>) v;
        throw inputError(key + ' must be a list.');
    }

    public static List<String> optStringList(Map<String, Object> m, String key) {
        List<Object> raw = optList(m, key);
        if (raw == null) return null;
        List<String> out = new List<String>();
        for (Object o : raw) {
            if (!(o instanceof String)) throw inputError(key + ' must be a list of strings.');
            out.add((String) o);
        }
        return out;
    }

    static Id reportId(Map<String, Object> m, String key) {
        String value = reqString(m, key);
        if (!Pattern.matches('00O[A-Za-z0-9]{12,15}', value)) throw inputError('A report id starts with 00O.');
        try {
            return Id.valueOf(value);
        } catch (Exception e) {
            throw inputError('A report id starts with 00O.');
        }
    }

    // ---- helpers ----

    /** The org's own domain, the base of report links. The local server uses its instance URL. */
    public static String baseUrl() {
        return URL.getOrgDomainUrl().toExternalForm().removeEnd('/');
    }

    /** For a LIKE clause: escape the quote and backslash, and the two wildcards (src/reports/api.ts). */
    @TestVisible
    static String soqlLike(String value) {
        return value.replace('\\', '\\\\').replace('\'', '\\\'').replace('%', '\\%').replace('_', '\\_');
    }

    /** A datetime as the REST query endpoint writes it, for example 2026-10-11T21:06:12.000+0000. */
    @TestVisible
    static String soqlDatetime(Datetime value) {
        return value == null ? null : value.formatGmt('yyyy-MM-dd\'T\'HH:mm:ss.SSS') + '+0000';
    }
}
