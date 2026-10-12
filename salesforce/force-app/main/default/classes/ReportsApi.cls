/**
 * The in-org REST door for the runner tools (docs/design.md, "v0.2: the in-org doors").
 * POST /services/apexrest/reports/v1/<tool> takes the local tool's JSON input and answers with the JSON
 * the local tool returns. A failure answers 400 (bad input) or 500 with the body the local fail() builds,
 * and a tool this door lacks answers 404. Ported from src/server.ts and src/format.ts.
 * list_report_types, query_report and describe_report_type call the org's own REST API through ReportsCallout (phase 3a).
 * create_report, update_report and clone_report save through the same callout (phase 3b), and only for a user with the
 * Reports_MCP_Write custom permission. There is no delete_report on this door.
 */
@RestResource(urlMapping='/reports/v1/*')
global with sharing class ReportsApi {
    public static final Integer DEFAULT_MAX_ROWS = 200;
    static final List<String> TOOLS = new List<String>{
        'search_reports', 'list_report_folders', 'list_report_types', 'describe_report', 'describe_report_type', 'run_report', 'query_report', 'combine_reports',
        'create_report', 'update_report', 'clone_report'
    };
    /** The save tools. Each needs WRITE_PERMISSION, checked before the input is read and before any callout. */
    static final Set<String> SAVE_TOOLS = new Set<String>{ 'create_report', 'update_report', 'clone_report' };
    static final Set<String> LOCAL_ONLY = new Set<String>{ 'delete_report' };
    public static final String WRITE_PERMISSION = 'Reports_MCP_Write';
    public static final String WRITE_PERMISSION_SET = 'Salesforce_Reports_MCP_Write';
    /** The longest report name Salesforce takes, as the local tools check it. */
    static final Integer MAX_NAME = 40;
    static final String OPERATOR_NOTE = 'Filter operators are not on the in-org door, because Apex does not expose them. Common ones: equals, notEqual, lessThan, greaterThan, lessOrEqual, greaterOrEqual, contains, notContain, startsWith, includes, excludes.';
    static final String FALLBACK_NOTE = 'The in-org door could not call the org\'s REST API under this sign-in, so it read the type through a saved report of that type instead.';

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
            String message = LOCAL_ONLY.contains(tool)
                ? tool + ' is not on the in-org door. Use the local server for it.'
                : 'There is no tool named "' + tool + '". This door offers ' + String.join(TOOLS, ', ') + '.';
            return new Answer(404, errorBody('UNKNOWN_TOOL', message, null));
        }
        try {
            if (SAVE_TOOLS.contains(tool)) requireWrite();
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
            when 'list_report_types' {
                return listReportTypes(input);
            }
            when 'describe_report_type' {
                return describeReportType(input);
            }
            when 'run_report' {
                return runToResult(reportId(input, 'reportId'), optMap(input, 'overrides'), optBool(input, 'detail'), optInt(input, 'maxRows', 1, ReportsShape.HARD_ROW_CEILING));
            }
            when 'query_report' {
                Map<String, Object> definition = new Map<String, Object>(input);
                definition.remove('detail');
                definition.remove('maxRows');
                return queryToResult(definition, optBool(input, 'detail'), optInt(input, 'maxRows', 1, ReportsShape.HARD_ROW_CEILING));
            }
            when 'create_report' {
                return createReport(input);
            }
            when 'update_report' {
                return updateReport(input);
            }
            when 'clone_report' {
                return cloneReport(input);
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

    static Map<String, Object> listReportTypes(Map<String, Object> input) {
        String search = optString(input, 'search');
        Integer lim = optInt(input, 'limit', 1, 500);
        Object categories = ReportsCallout.send('GET', '/analytics/reportTypes', null);
        return ReportsSummary.summarizeReportTypes(categories instanceof List<Object> ? (List<Object>) categories : new List<Object>(), search, lim);
    }

    static Map<String, Object> describeReportType(Map<String, Object> input) {
        String type = reqString(input, 'type');
        String search = optString(input, 'search');
        Integer lim = optInt(input, 'limit', 1, 1000);
        try {
            Object described = ReportsCallout.send('GET', '/analytics/reportTypes/' + ReportsCallout.segment(type), null);
            return ReportsSummary.summarizeReportTypeJson(asMap(described, 'The report type describe'), type, search, lim);
        } catch (ApiException e) {
            if (e.code != 'CALLOUT_SESSION') throw e;
        }
        return describeThroughSavedReport(type, search, lim);
    }

    /** The phase 1 path, for a sign-in whose session cannot call the REST API: read the type through a saved report of it. */
    static Map<String, Object> describeThroughSavedReport(String type, String search, Integer lim) {
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
            out.put('notes', new List<String>{ FALLBACK_NOTE, OPERATOR_NOTE });
            return out;
        }
        throw apiError(400, 'NO_SAVED_REPORT',
            'The in-org door could not call the org\'s REST API under this sign-in, so it reads a report type through a saved report of that type, and this user can see no report of type "' + type + '".',
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
        List<Map<String, Object>> definitions = new List<Map<String, Object>>();
        for (Object o : inputs) {
            Map<String, Object> item = asMap(o, 'inputs');
            String alias = reqString(item, 'alias');
            if (alias == '') throw inputError('Each input needs an alias.');
            if ((item.get('reportId') != null) == (item.get('definition') != null)) {
                throw inputError('Input "' + alias + '" needs exactly one of reportId and definition.');
            }
            aliases.add(alias);
            // A definition runs through query_report, a saved report through run_report.
            definitions.add(optMap(item, 'definition'));
            ids.add(item.get('reportId') == null ? null : reportId(item, 'reportId'));
            overrides.add(optMap(item, 'overrides'));
        }
        List<Map<String, Object>> results = new List<Map<String, Object>>();
        for (Integer i = 0; i < ids.size(); i++) {
            results.add(definitions[i] != null ? queryToResult(definitions[i], detail, maxRows) : runToResult(ids[i], overrides[i], detail, maxRows));
        }
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

    /**
     * query_report's core, shared with combine_reports: map the definition, post it to /analytics/reports/query
     * through ReportsCallout, and shape the REST JSON with the in-org row cap run_report uses.
     */
    public static Map<String, Object> queryToResult(Map<String, Object> definition, Boolean detail, Integer maxRows) {
        if (String.isBlank(optString(definition, 'reportType'))) throw inputError('A report defined in the call needs reportType. Find one with list_report_types.');
        ReportsDefinition.Mapped mapped = ReportsDefinition.toReportMetadata(definition, false);
        ensureDetailColumn(mapped);
        List<String> notes = new List<String>(mapped.notes);
        // Ask for detail rows only when they will be shown, to keep the response and the heap small. The local server
        // asks unless detail is false; the shaped result is the same (docs/probes/v0.2-phase3.md).
        Boolean wantsDetail = detail != null ? detail : mapped.metadata.get('reportFormat') == 'TABULAR';
        Object raw = ReportsCallout.send('POST', '/analytics/reports/query?includeDetails=' + wantsDetail, new Map<String, Object>{ 'reportMetadata' => mapped.metadata });
        ReportsShape.guardHeap();
        Map<String, Object> result = asMap(raw, 'The query result');
        Object meta = result.get('reportMetadata');
        Boolean tabular = meta instanceof Map<String, Object> && ((Map<String, Object>) meta).get('reportFormat') == 'TABULAR';
        Integer limitRows = Math.min(maxRows == null ? DEFAULT_MAX_ROWS : maxRows, ReportsShape.HARD_ROW_CEILING);
        return ReportsShape.shapeJson(result, limitRows, detail != null ? detail : tabular, baseUrl(), notes);
    }

    /**
     * Salesforce rejects a grouped report with no detail column, and reads an empty list as "all columns"
     * (which then trips the 100-column limit). Give such a report one ungrouped column from the type's defaults.
     */
    static void ensureDetailColumn(ReportsDefinition.Mapped mapped) {
        Map<String, Object> meta = mapped.metadata;
        Set<String> grouped = new Set<String>();
        for (String side : new List<String>{ 'groupingsDown', 'groupingsAcross' }) {
            Object found = meta.get(side);
            if (found instanceof List<Object>) for (Object g : (List<Object>) found) grouped.add((String) ((Map<String, Object>) g).get('name'));
        }
        Object columns = meta.get('detailColumns');
        if (grouped.isEmpty() || (columns instanceof List<Object> && !((List<Object>) columns).isEmpty())) return;
        Object type = meta.get('reportType');
        if (!(type instanceof Map<String, Object>) || ((Map<String, Object>) type).get('type') == null) return;
        String typeName = (String) ((Map<String, Object>) type).get('type');
        Map<String, Object> described = asMap(ReportsCallout.send('GET', '/analytics/reportTypes/' + ReportsCallout.segment(typeName), null), 'The report type describe');
        Object defaults = described.get('reportMetadata') instanceof Map<String, Object> ? ((Map<String, Object>) described.get('reportMetadata')).get('detailColumns') : null;
        String column;
        if (defaults instanceof List<Object>) {
            for (Object c : (List<Object>) defaults) {
                if (!grouped.contains((String) c)) {
                    column = (String) c;
                    break;
                }
            }
        }
        if (column == null) throw inputError('Give at least one detail column that is not a grouping.');
        meta.put('detailColumns', new List<String>{ column });
        mapped.notes.add('No detail column was given, so ' + column + ' was added; Salesforce needs one on a grouped report.');
    }

    // ---- save tools (phase 3b), ported from src/server.ts ----

    /** The save tools need the Reports_MCP_Write custom permission. The read tools never check it. */
    static void requireWrite() {
        if (FeatureManagement.checkPermission(WRITE_PERMISSION)) return;
        throw apiError(403, 'WRITE_NOT_ALLOWED',
            'Saving reports on the in-org door needs the ' + WRITE_PERMISSION + ' custom permission, and this user does not have it.',
            'Ask an admin to assign the permission set ' + WRITE_PERMISSION_SET + ' to users who may save reports, or use the local server.');
    }

    /**
     * create_report: from a definition, or from fromReportId plus changes (the saved report is copied and the changes
     * applied). POST /analytics/reports. With no folderId the report lands in the user's Private Reports folder.
     */
    static Map<String, Object> createReport(Map<String, Object> input) {
        String name = nameOf(input, true);
        String description = optString(input, 'description');
        String folderId = optString(input, 'folderId');
        Id fromReportId = input.get('fromReportId') == null ? null : reportId(input, 'fromReportId');
        Map<String, Object> definition = definitionOf(input, new List<String>{ 'name', 'description', 'folderId', 'fromReportId' });
        ReportsDefinition.Mapped mapped;
        if (fromReportId != null) {
            Map<String, Object> before = savedMetadata(fromReportId);
            mapped = ReportsDefinition.toReportMetadata(definition, true);
            mapped.metadata = applyChanges(before, definition, mapped.metadata);
        } else {
            if (String.isBlank(optString(definition, 'reportType'))) {
                throw inputError('create_report needs reportType, or fromReportId to start from a saved report. Find a type with list_report_types.');
            }
            mapped = ReportsDefinition.toReportMetadata(definition, false);
        }
        ensureDetailColumn(mapped);
        Map<String, Object> metadata = mapped.metadata;
        metadata.put('name', name);
        if (String.isNotEmpty(description)) metadata.put('description', description);
        if (String.isNotEmpty(folderId)) metadata.put('folderId', folderId);
        Object created = ReportsCallout.send('POST', '/analytics/reports', new Map<String, Object>{ 'reportMetadata' => metadata });
        Map<String, Object> summary = ReportsSummary.summarizeReportJson(asMap(created, 'The saved report'), baseUrl());
        Map<String, Object> out = savedReport(summary);
        out.put('summary', summary);
        out.put('notes', mapped.notes);
        return out;
    }

    /**
     * update_report: PATCH /analytics/reports/{id} with only the given fields. A sent list replaces the saved list.
     * Answers the saved summary and one line per field sent, as the local tool does.
     */
    static Map<String, Object> updateReport(Map<String, Object> input) {
        Id id = reportId(input, 'reportId');
        String name = nameOf(input, false);
        String description = optString(input, 'description');
        String folderId = optString(input, 'folderId');
        Map<String, Object> definition = definitionOf(input, new List<String>{ 'reportId', 'name', 'description', 'folderId' });
        ReportsDefinition.Mapped mapped = ReportsDefinition.toReportMetadata(definition, true);
        Map<String, Object> patch = new Map<String, Object>(mapped.metadata);
        if (String.isNotEmpty(name)) patch.put('name', name);
        if (description != null) patch.put('description', description);
        if (String.isNotEmpty(folderId)) patch.put('folderId', folderId);
        if (patch.isEmpty()) throw inputError('Nothing to update. Give at least one field to change.');
        Map<String, Object> before = savedMetadata(id);
        List<Object> aggregates = optList(definition, 'aggregates');
        if (aggregates != null && definition.get('columns') == null) {
            // A new aggregate needs its column among the detail columns; keep the saved ones.
            List<Object> saved = items(before.get('detailColumns'));
            List<Object> columns = new List<Object>(saved);
            for (String c : ReportsDefinition.aggregateColumns(ReportsDefinition.mapAggregates(aggregates))) {
                if (!saved.contains(c)) columns.add(c);
            }
            if (columns.size() > saved.size()) patch.put('detailColumns', columns);
        }
        Map<String, Object> after = asMap(
            ReportsCallout.send('PATCH', '/analytics/reports/' + ReportsCallout.segment(id), new Map<String, Object>{ 'reportMetadata' => patch }),
            'The saved report'
        );
        Map<String, Object> afterMeta = after.get('reportMetadata') instanceof Map<String, Object> ? (Map<String, Object>) after.get('reportMetadata') : new Map<String, Object>();
        List<String> changes = new List<String>();
        for (String key : patch.keySet()) {
            // As JSON.stringify writes them; a missing key is undefined there, null here.
            String was = before.containsKey(key) ? sortedJson(before.get(key)) : null;
            String now = afterMeta.containsKey(key) ? sortedJson(afterMeta.get(key)) : null;
            Boolean same = was == null ? now == null : was.equals(now);
            changes.add(same ? key + ': unchanged' : key + ': ' + clip(was) + ' -> ' + clip(now));
        }
        return new Map<String, Object>{ 'summary' => ReportsSummary.summarizeReportJson(after, baseUrl()), 'changes' => changes, 'notes' => mapped.notes };
    }

    /** clone_report: POST /analytics/reports?cloneId={id}, as the local server calls it. */
    static Map<String, Object> cloneReport(Map<String, Object> input) {
        Id id = reportId(input, 'reportId');
        String name = nameOf(input, false);
        String folderId = optString(input, 'folderId');
        Map<String, Object> metadata = new Map<String, Object>();
        if (String.isNotEmpty(name)) metadata.put('name', name);
        if (String.isNotEmpty(folderId)) metadata.put('folderId', folderId);
        Object cloned = ReportsCallout.send('POST', '/analytics/reports?cloneId=' + ReportsCallout.segment(id), new Map<String, Object>{ 'reportMetadata' => metadata });
        return savedReport(ReportsSummary.summarizeReportJson(asMap(cloned, 'The cloned report'), baseUrl()));
    }

    /** {id, name, folder, folderId, url} of a saved report, as create_report and clone_report answer. */
    static Map<String, Object> savedReport(Map<String, Object> summary) {
        String id = (String) summary.get('id');
        Map<String, Object> out = new Map<String, Object>{ 'id' => id, 'name' => summary.get('name') };
        String folder = folderName(id);
        if (folder != null) out.put('folder', folder);
        out.put('folderId', summary.get('folderId'));
        if (summary.get('url') != null) out.put('url', summary.get('url'));
        return out;
    }

    /** The saved report's REST reportMetadata, through the callout, so a copy keeps the fields Apex does not expose. */
    static Map<String, Object> savedMetadata(Id id) {
        Map<String, Object> described = asMap(ReportsCallout.send('GET', '/analytics/reports/' + ReportsCallout.segment(id) + '/describe', null), 'The report describe');
        return described.get('reportMetadata') instanceof Map<String, Object> ? (Map<String, Object>) described.get('reportMetadata') : new Map<String, Object>();
    }

    /**
     * src/server.ts applyChanges: the saved metadata of `before`, with the changes applied, ready to POST as a new report.
     * Fields that identify the old report are dropped; a list in `changes` replaces the saved list.
     */
    @TestVisible
    static Map<String, Object> applyChanges(Map<String, Object> before, Map<String, Object> def, Map<String, Object> changes) {
        Map<String, Object> out = new Map<String, Object>(before);
        for (String key : new List<String>{ 'id', 'developerName', 'folderId', 'name' }) out.remove(key);
        out.putAll(changes);
        // Adding groupings to a flat copy makes it a summary or matrix.
        if (def.get('format') == null && changes.get('reportFormat') == null) {
            Boolean across = !items(out.get('groupingsAcross')).isEmpty();
            Boolean down = !items(out.get('groupingsDown')).isEmpty();
            out.put('reportFormat', across ? 'MATRIX' : (down ? 'SUMMARY' : before.get('reportFormat')));
        }
        Set<String> grouped = new Set<String>();
        for (String side : new List<String>{ 'groupingsDown', 'groupingsAcross' }) {
            for (Object g : items(out.get(side))) grouped.add((String) ((Map<String, Object>) g).get('name'));
        }
        List<Object> columns = new List<Object>();
        for (Object c : items(out.get('detailColumns'))) if (!grouped.contains((String) c)) columns.add(c);
        List<Object> aggregates = optList(def, 'aggregates');
        if (aggregates != null) {
            // A new aggregate needs its column among the detail columns.
            for (String c : ReportsDefinition.aggregateColumns(ReportsDefinition.mapAggregates(aggregates))) {
                if (!columns.contains(c) && !grouped.contains(c)) columns.add(c);
            }
        }
        out.put('detailColumns', columns);
        return out;
    }

    /** The report name: 1 to 40 characters, required for create_report. */
    static String nameOf(Map<String, Object> input, Boolean required) {
        String name = required ? reqString(input, 'name') : optString(input, 'name');
        if (name != null && (name.length() < 1 || name.length() > MAX_NAME)) throw inputError('name takes 1 to ' + MAX_NAME + ' characters.');
        return name;
    }

    /** The definition fields of a save tool's input: the input without the tool's own fields. */
    static Map<String, Object> definitionOf(Map<String, Object> input, List<String> own) {
        Map<String, Object> definition = new Map<String, Object>(input);
        for (String key : own) definition.remove(key);
        return definition;
    }

    /** The report's folder name (Private Reports for a private one), or null when this user cannot read it. */
    static String folderName(String id) {
        if (String.isEmpty(id)) return null;
        try {
            List<Report> rows = [SELECT FolderName FROM Report WHERE Id = :id WITH USER_MODE];
            return rows.isEmpty() ? null : rows[0].FolderName;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * JSON with object keys sorted. A map from JSON.deserializeUntyped loses the response's key order, and Salesforce
     * writes its keys in alphabetical order, so this writes what JSON.stringify writes on the local server.
     */
    @TestVisible
    static String sortedJson(Object value) {
        List<String> parts = new List<String>();
        if (value instanceof Map<String, Object>) {
            Map<String, Object> m = (Map<String, Object>) value;
            List<String> keys = new List<String>(m.keySet());
            keys.sort();
            for (String k : keys) parts.add(JSON.serialize(k) + ':' + sortedJson(m.get(k)));
            return '{' + String.join(parts, ',') + '}';
        }
        if (value instanceof List<Object>) {
            for (Object o : (List<Object>) value) parts.add(sortedJson(o));
            return '[' + String.join(parts, ',') + ']';
        }
        return JSON.serialize(value);
    }

    /** src/server.ts clip, for a changes line. */
    @TestVisible
    static String clip(String text) {
        if (text == null) return '(none)';
        return text.length() > 160 ? text.substring(0, 157) + '...' : text;
    }

    static List<Object> items(Object value) {
        return value instanceof List<Object> ? (List<Object>) value : new List<Object>();
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

    /** src/format.ts hintFor. A 401 never gets here: ReportsCallout answers it with CALLOUT_SESSION. */
    public static String hintFor(Integer status, String code, String message) {
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
