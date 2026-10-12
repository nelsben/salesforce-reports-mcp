/**
 * Core layer: the report tools, whichever door calls them. call takes a tool name and the JSON body text, checks that
 * the tool exists, checks the Reports_Write custom permission for a save tool before it reads the input or calls
 * out, then dispatches to the tool and answers with the JSON map the local tool returns (ported from src/server.ts).
 * Every failure leaves as a ReportsException with a category, never an HTTP status. The SOQL tools and
 * Reports.ReportManager run here, the callout tools go through ReportsCallout, and the class runs with sharing and its
 * queries in user mode, so sharing, folder access and field-level security stay Salesforce's own.
 */
public with sharing class ReportsService {
    public static final Integer DEFAULT_MAX_ROWS = 200;
    static final List<String> TOOLS = new List<String>{
        'search_reports', 'list_report_folders', 'list_report_types', 'describe_report', 'describe_report_type', 'run_report', 'query_report', 'combine_reports',
        'create_report', 'update_report', 'clone_report'
    };
    /** The save tools. Each needs WRITE_PERMISSION, checked before the input is read and before any callout. */
    static final Set<String> SAVE_TOOLS = new Set<String>{ 'create_report', 'update_report', 'clone_report' };
    static final Set<String> LOCAL_ONLY = new Set<String>{ 'delete_report' };
    public static final String WRITE_PERMISSION = 'Reports_Write';
    public static final String WRITE_PERMISSION_SET = 'Salesforce_Reports_Write';
    /** The longest report name Salesforce takes, as the local tools check it. */
    static final Integer MAX_NAME = 40;
    static final String OPERATOR_NOTE = 'Filter operators are not on the in-org door, because Apex does not expose them. Common ones: equals, notEqual, lessThan, greaterThan, lessOrEqual, greaterOrEqual, contains, notContain, startsWith, includes, excludes.';
    static final String FALLBACK_NOTE = 'The in-org door could not call the org\'s REST API under this sign-in, so it read the type through a saved report of that type instead.';

    /**
     * The tool's answer: the JSON map the local tool returns. An unknown tool throws UNKNOWN_TOOL, a save tool without
     * the write permission throws FORBIDDEN before the body is parsed, and any other failure is turned into a
     * ReportsException by ReportsException.fromException, so the caller sees one error type.
     */
    public static Object call(String tool, String body) {
        try {
            if (!TOOLS.contains(tool)) {
                String message = LOCAL_ONLY.contains(tool)
                    ? tool + ' is not on the in-org door. Use the local server for it.'
                    : 'There is no tool named "' + tool + '". This door offers ' + String.join(TOOLS, ', ') + '.';
                throw ReportsException.create(ReportsException.ErrorCategory.UNKNOWN_TOOL, 'UNKNOWN_TOOL', message, null);
            }
            if (SAVE_TOOLS.contains(tool)) requireWrite();
            return dispatch(tool, ReportsInput.parse(body));
        } catch (Exception e) {
            throw ReportsException.fromException(e);
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
                return runToResult(ReportsInput.reportId(input, 'reportId'), ReportsInput.optMap(input, 'overrides'), ReportsInput.optBool(input, 'detail'), ReportsInput.optInt(input, 'maxRows', 1, ReportsShape.HARD_ROW_CEILING));
            }
            when 'query_report' {
                Map<String, Object> definition = new Map<String, Object>(input);
                definition.remove('detail');
                definition.remove('maxRows');
                return queryToResult(definition, ReportsInput.optBool(input, 'detail'), ReportsInput.optInt(input, 'maxRows', 1, ReportsShape.HARD_ROW_CEILING));
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
        String query = ReportsInput.optString(input, 'query');
        String folder = ReportsInput.optString(input, 'folder');
        String format = ReportsInput.optString(input, 'format');
        Integer lim = ReportsInput.optInt(input, 'limit', 1, 200);
        Map<String, String> formats = new Map<String, String>{ 'TABULAR' => 'Tabular', 'SUMMARY' => 'Summary', 'MATRIX' => 'Matrix', 'JOINED' => 'MultiBlock' };
        if (format != null && !formats.containsKey(format)) throw ReportsException.invalidInput('format must be TABULAR, SUMMARY, MATRIX or JOINED.');
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
        String search = ReportsInput.optString(input, 'search');
        Integer lim = ReportsInput.optInt(input, 'limit', 1, 200);
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
        Id id = ReportsInput.reportId(input, 'reportId');
        Boolean includeMetadata = ReportsInput.optBool(input, 'includeMetadata') == true;
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
        String search = ReportsInput.optString(input, 'search');
        Integer lim = ReportsInput.optInt(input, 'limit', 1, 500);
        Object categories = ReportsCallout.send('GET', '/analytics/reportTypes', null);
        return ReportsSummary.summarizeReportTypes(categories instanceof List<Object> ? (List<Object>) categories : new List<Object>(), search, lim);
    }

    static Map<String, Object> describeReportType(Map<String, Object> input) {
        String type = ReportsInput.reqString(input, 'type');
        String search = ReportsInput.optString(input, 'search');
        Integer lim = ReportsInput.optInt(input, 'limit', 1, 1000);
        try {
            Object described = ReportsCallout.send('GET', '/analytics/reportTypes/' + ReportsCallout.segment(type), null);
            return ReportsSummary.summarizeReportTypeJson(ReportsInput.asMap(described, 'The report type describe'), type, search, lim);
        } catch (ReportsException e) {
            if (e.code != 'CALLOUT_SESSION' && e.code != 'CALLOUT_CREDENTIAL') throw e;
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
        throw ReportsException.create(ReportsException.ErrorCategory.INVALID_INPUT, 'NO_SAVED_REPORT',
            'The in-org door could not call the org\'s REST API under this sign-in, so it reads a report type through a saved report of that type, and this user can see no report of type "' + type + '".',
            'Save a report of this type first, or use the local server, which reads the type directly.');
    }

    static Map<String, Object> combineReports(Map<String, Object> input) {
        String mode = ReportsInput.reqString(input, 'mode');
        if (mode != 'stack' && mode != 'join') throw ReportsException.invalidInput('mode must be stack or join.');
        List<Object> inputs = ReportsInput.optList(input, 'inputs');
        if (inputs == null || inputs.size() < 2 || inputs.size() > 5) throw ReportsException.invalidInput('inputs takes 2 to 5 reports.');
        List<String> joinOn = ReportsInput.optStringList(input, 'joinOn');
        Boolean detail = ReportsInput.optBool(input, 'detail');
        Integer maxRows = ReportsInput.optInt(input, 'maxRows', 1, ReportsShape.HARD_ROW_CEILING);
        List<String> aliases = new List<String>();
        List<Id> ids = new List<Id>();
        List<Map<String, Object>> overrides = new List<Map<String, Object>>();
        List<Map<String, Object>> definitions = new List<Map<String, Object>>();
        for (Object o : inputs) {
            Map<String, Object> item = ReportsInput.asMap(o, 'inputs');
            String alias = ReportsInput.reqString(item, 'alias');
            if (alias == '') throw ReportsException.invalidInput('Each input needs an alias.');
            if ((item.get('reportId') != null) == (item.get('definition') != null)) {
                throw ReportsException.invalidInput('Input "' + alias + '" needs exactly one of reportId and definition.');
            }
            aliases.add(alias);
            // A definition runs through query_report, a saved report through run_report.
            definitions.add(ReportsInput.optMap(item, 'definition'));
            ids.add(item.get('reportId') == null ? null : ReportsInput.reportId(item, 'reportId'));
            overrides.add(ReportsInput.optMap(item, 'overrides'));
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
        if (String.isBlank(ReportsInput.optString(definition, 'reportType'))) throw ReportsException.invalidInput('A report defined in the call needs reportType. Find one with list_report_types.');
        ReportsDefinition.Mapped mapped = ReportsDefinition.toReportMetadata(definition, false);
        ensureDetailColumn(mapped);
        List<String> notes = new List<String>(mapped.notes);
        // Ask for detail rows only when they will be shown, to keep the response and the heap small. The local server
        // asks unless detail is false; the shaped result is the same (docs/probes/v0.2-phase3.md).
        Boolean wantsDetail = detail != null ? detail : mapped.metadata.get('reportFormat') == 'TABULAR';
        Object raw = ReportsCallout.send('POST', '/analytics/reports/query?includeDetails=' + wantsDetail, new Map<String, Object>{ 'reportMetadata' => mapped.metadata });
        ReportsShape.guardHeap();
        Map<String, Object> result = ReportsInput.asMap(raw, 'The query result');
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
        Map<String, Object> described = ReportsInput.asMap(ReportsCallout.send('GET', '/analytics/reportTypes/' + ReportsCallout.segment(typeName), null), 'The report type describe');
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
        if (column == null) throw ReportsException.invalidInput('Give at least one detail column that is not a grouping.');
        meta.put('detailColumns', new List<String>{ column });
        mapped.notes.add('No detail column was given, so ' + column + ' was added; Salesforce needs one on a grouped report.');
    }

    // ---- save tools (phase 3b), ported from src/server.ts ----

    /** The save tools need the Reports_Write custom permission. The read tools never check it. */
    static void requireWrite() {
        if (FeatureManagement.checkPermission(WRITE_PERMISSION)) return;
        throw ReportsException.create(ReportsException.ErrorCategory.FORBIDDEN, 'WRITE_NOT_ALLOWED',
            'Saving reports on the in-org door needs the ' + WRITE_PERMISSION + ' custom permission, and this user does not have it.',
            'Ask an admin to assign the permission set ' + WRITE_PERMISSION_SET + ' to users who may save reports, or use the local server.');
    }

    /**
     * create_report: from a definition, or from fromReportId plus changes (the saved report is copied and the changes
     * applied). POST /analytics/reports. With no folderId the report lands in the user's Private Reports folder.
     */
    static Map<String, Object> createReport(Map<String, Object> input) {
        String name = nameOf(input, true);
        String description = ReportsInput.optString(input, 'description');
        String folderId = ReportsInput.optString(input, 'folderId');
        Id fromReportId = input.get('fromReportId') == null ? null : ReportsInput.reportId(input, 'fromReportId');
        Map<String, Object> definition = definitionOf(input, new List<String>{ 'name', 'description', 'folderId', 'fromReportId' });
        ReportsDefinition.Mapped mapped;
        if (fromReportId != null) {
            Map<String, Object> before = savedMetadata(fromReportId);
            mapped = ReportsDefinition.toReportMetadata(definition, true);
            mapped.metadata = applyChanges(before, definition, mapped.metadata);
        } else {
            if (String.isBlank(ReportsInput.optString(definition, 'reportType'))) {
                throw ReportsException.invalidInput('create_report needs reportType, or fromReportId to start from a saved report. Find a type with list_report_types.');
            }
            mapped = ReportsDefinition.toReportMetadata(definition, false);
        }
        ensureDetailColumn(mapped);
        Map<String, Object> metadata = mapped.metadata;
        metadata.put('name', name);
        if (String.isNotEmpty(description)) metadata.put('description', description);
        if (String.isNotEmpty(folderId)) metadata.put('folderId', folderId);
        Object created = ReportsCallout.send('POST', '/analytics/reports', new Map<String, Object>{ 'reportMetadata' => metadata });
        Map<String, Object> summary = ReportsSummary.summarizeReportJson(ReportsInput.asMap(created, 'The saved report'), baseUrl());
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
        Id id = ReportsInput.reportId(input, 'reportId');
        String name = nameOf(input, false);
        String description = ReportsInput.optString(input, 'description');
        String folderId = ReportsInput.optString(input, 'folderId');
        Map<String, Object> definition = definitionOf(input, new List<String>{ 'reportId', 'name', 'description', 'folderId' });
        ReportsDefinition.Mapped mapped = ReportsDefinition.toReportMetadata(definition, true);
        Map<String, Object> patch = new Map<String, Object>(mapped.metadata);
        if (String.isNotEmpty(name)) patch.put('name', name);
        if (description != null) patch.put('description', description);
        if (String.isNotEmpty(folderId)) patch.put('folderId', folderId);
        if (patch.isEmpty()) throw ReportsException.invalidInput('Nothing to update. Give at least one field to change.');
        Map<String, Object> before = savedMetadata(id);
        List<Object> aggregates = ReportsInput.optList(definition, 'aggregates');
        if (aggregates != null && definition.get('columns') == null) {
            // A new aggregate needs its column among the detail columns; keep the saved ones.
            List<Object> saved = items(before.get('detailColumns'));
            List<Object> columns = new List<Object>(saved);
            for (String c : ReportsDefinition.aggregateColumns(ReportsDefinition.mapAggregates(aggregates))) {
                if (!saved.contains(c)) columns.add(c);
            }
            if (columns.size() > saved.size()) patch.put('detailColumns', columns);
        }
        Map<String, Object> after = ReportsInput.asMap(
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
        Id id = ReportsInput.reportId(input, 'reportId');
        String name = nameOf(input, false);
        String folderId = ReportsInput.optString(input, 'folderId');
        Map<String, Object> metadata = new Map<String, Object>();
        if (String.isNotEmpty(name)) metadata.put('name', name);
        if (String.isNotEmpty(folderId)) metadata.put('folderId', folderId);
        Object cloned = ReportsCallout.send('POST', '/analytics/reports?cloneId=' + ReportsCallout.segment(id), new Map<String, Object>{ 'reportMetadata' => metadata });
        return savedReport(ReportsSummary.summarizeReportJson(ReportsInput.asMap(cloned, 'The cloned report'), baseUrl()));
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
        Map<String, Object> described = ReportsInput.asMap(ReportsCallout.send('GET', '/analytics/reports/' + ReportsCallout.segment(id) + '/describe', null), 'The report describe');
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
        List<Object> aggregates = ReportsInput.optList(def, 'aggregates');
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
        String name = required ? ReportsInput.reqString(input, 'name') : ReportsInput.optString(input, 'name');
        if (name != null && (name.length() < 1 || name.length() > MAX_NAME)) throw ReportsException.invalidInput('name takes 1 to ' + MAX_NAME + ' characters.');
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
