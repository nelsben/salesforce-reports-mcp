/**
 * Runs the door against the org's own saved reports, so it needs SeeAllData. It creates no records and no reports.
 */
@IsTest(SeeAllData='true')
private class ReportsApiTest {
    static ReportsApi.Answer call(String tool, String body) {
        return ReportsApi.handle(tool, body);
    }

    static Map<String, Object> ok(ReportsApi.Answer a) {
        Assert.areEqual(200, a.status, JSON.serialize(a.body));
        return (Map<String, Object>) a.body;
    }

    static String errorCode(ReportsApi.Answer a) {
        return (String) ((Map<String, Object>) ((Map<String, Object>) a.body).get('error')).get('code');
    }

    /** A saved tabular or summary report this user can run, or null in an org with none. */
    static Report anyReport(String format) {
        List<Report> rows = [SELECT Id, Format FROM Report WHERE Format = :format ORDER BY LastModifiedDate DESC LIMIT 1];
        return rows.isEmpty() ? null : rows[0];
    }

    @IsTest
    static void answersTheContract() {
        Test.setMock(HttpCalloutMock.class, ReportsCalloutTest.refusing());
        Assert.areEqual(404, call('create_report', '{}').status);
        Assert.areEqual(400, call('query_report', '{}').status);
        Assert.areEqual('UNKNOWN_TOOL', errorCode(call('nope', '{}')));
        Assert.areEqual(400, call('search_reports', 'not json').status);
        Assert.areEqual(400, call('search_reports', '[1]').status);
        Assert.areEqual('INVALID_INPUT', errorCode(call('run_report', '{"reportId":"abc"}')));
        Assert.areNotEqual(200, call('run_report', '{"reportId":"00O000000000000"}').status);
        Assert.areEqual(400, call('search_reports', '{"limit":0}').status);
        Assert.areEqual(400, call('search_reports', '{"limit":2.5}').status);
        Assert.areEqual(400, call('search_reports', '{"format":"PIVOT"}').status);
        Assert.areEqual(400, call('search_reports', '{"query":5}').status);
        Assert.areEqual(400, call('describe_report', '{"reportId":"00O000000000000","includeMetadata":"yes"}').status);
        Assert.areEqual(400, call('describe_report_type', '{"type":"No_Such_Type__c"}').status);
        Assert.areEqual(400, call('combine_reports', '{"mode":"zip","inputs":[]}').status);
        Assert.areEqual(400, call('combine_reports', '{"mode":"stack","inputs":[{"alias":"a"}]}').status);
        Assert.areEqual(400, call('combine_reports', '{"mode":"stack","inputs":[{"alias":"a"},{"alias":"b"}]}').status);
        Assert.areEqual(400, call('combine_reports', '{"mode":"stack","inputs":[{"alias":"a","definition":{}},{"alias":"b","reportId":"00O000000000000"}]}').status);
        Assert.areEqual(400, call('combine_reports', '{"mode":"stack","inputs":[{"alias":"","reportId":"00O000000000000"},{"alias":"b","reportId":"00O000000000000"}]}').status);
        Assert.areEqual(400, call('combine_reports', '{"mode":"stack","inputs":[1,2]}').status);
        Assert.areEqual(400, call('combine_reports', '{"mode":"stack","inputs":"x"}').status);
        Assert.areEqual(400, call('combine_reports', '{"mode":"stack","joinOn":[1],"inputs":[]}').status);
        Assert.areEqual(400, call('run_report', '{"reportId":"00O000000000000","overrides":[]}').status);
    }

    @IsTest
    static void servesOverHttp() {
        RestContext.request = new RestRequest();
        RestContext.response = new RestResponse();
        RestContext.request.requestURI = '/services/apexrest/reports/v1/list_report_folders';
        RestContext.request.requestBody = Blob.valueOf('{"search":"public"}');
        ReportsApi.post();
        Assert.areEqual(200, RestContext.response.statusCode);
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(RestContext.response.responseBody.toString());
        Assert.areEqual('unfiled$public', ((Map<String, Object>) ((List<Object>) body.get('folders'))[0]).get('developerName'));
    }

    @IsTest
    static void searchesAndListsFolders() {
        Map<String, Object> found = ok(call('search_reports', '{"query":"a_b%\'","folder":"x","format":"SUMMARY","limit":5}'));
        Assert.isNotNull(found.get('count'));
        Map<String, Object> recent = ok(call('search_reports', null));
        Assert.areEqual(((List<Object>) recent.get('reports')).size(), recent.get('count'));
        Map<String, Object> folders = ok(call('list_report_folders', '{"search":"zz-no-such-folder","limit":3}'));
        Assert.areEqual(0, folders.get('count'));
    }

    @IsTest
    static void describesAndRunsSavedReports() {
        // A refused callout sends describe_report_type down the phase 1 path, through a saved report of the type.
        Test.setMock(HttpCalloutMock.class, ReportsCalloutTest.refusing());
        for (String format : new List<String>{ 'Tabular', 'Summary' }) {
            Report r = anyReport(format);
            if (r == null) continue;
            String id = '"reportId":"' + r.Id + '"';
            Map<String, Object> described = ok(call('describe_report', '{' + id + ',"includeMetadata":true}'));
            Assert.areEqual(String.valueOf(r.Id), described.get('id'));
            Assert.isNotNull(described.get('folder'));
            Map<String, Object> run = ok(call('run_report', '{' + id + ',"detail":true,"maxRows":1}'));
            Assert.isNotNull(run.get('report'));
            ok(call('run_report', '{' + id + ',"detail":false,"overrides":{"filters":[]}}'));
            String type = Reports.ReportManager.describeReport(r.Id).getReportMetadata().getReportType().getType();
            Map<String, Object> typeSummary = ok(call('describe_report_type', '{"type":"' + type + '","search":"e","limit":5}'));
            Assert.isTrue((Integer) typeSummary.get('fieldsShown') <= 5);
            Assert.areEqual(2, ((List<Object>) typeSummary.get('notes')).size());
            Map<String, Object> combined = ok(call('combine_reports', '{"mode":"stack","detail":true,"maxRows":2,"inputs":[{"alias":"a",' + id + '},{"alias":"b",' + id + '}]}'));
            Assert.isNotNull(combined.get('report'));
        }
        Report summary = anyReport('Summary');
        if (summary != null) {
            Reports.ReportMetadata meta = Reports.ReportManager.describeReport(summary.Id).getReportMetadata();
            if (meta.getGroupingsDown() != null && meta.getGroupingsDown().size() == 1 && (meta.getGroupingsAcross() == null || meta.getGroupingsAcross().isEmpty())) {
                String id = '"reportId":"' + summary.Id + '"';
                ok(call('combine_reports', '{"mode":"join","inputs":[{"alias":"a",' + id + '},{"alias":"b",' + id + '}]}'));
            }
            Assert.areEqual(400, call('run_report', '{"reportId":"' + summary.Id + '","overrides":{"reportType":"No_Such_Type__c"}}').status);
        }
    }

    @IsTest
    static void shapesCells() {
        Assert.isNull(ReportsShape.cell(null, '-', 'string'));
        Assert.areEqual(5, ReportsShape.cell(5, '5', 'int'));
        Assert.areEqual(2.5, ReportsShape.cell('2.5', '2.5', 'double'));
        Assert.areEqual('n/a', ReportsShape.cell('n/a', 'n/a', 'percent'));
        Assert.areEqual(true, ReportsShape.cell(true, 'true', 'boolean'));
        Assert.areEqual(true, ReportsShape.cell('true', 'true', 'boolean'));
        Assert.areEqual(false, ReportsShape.cell('false', 'false', 'boolean'));
        Assert.areEqual('maybe', ReportsShape.cell('x', 'maybe', 'boolean'));
        Assert.areEqual('2026-12-22', ReportsShape.cell(Date.newInstance(2026, 12, 22), '12/22/2026', 'date'));
        Assert.areEqual('2026-12-22T10:30:00Z', ReportsShape.cell(Datetime.newInstanceGmt(2026, 12, 22, 10, 30, 0), 'x', 'datetime'));
        Assert.areEqual('10:30', ReportsShape.cell('10:30', '10:30', 'time'));
        Assert.areEqual('Acme', ReportsShape.cell(UserInfo.getUserId(), 'Acme', 'string'));
        Assert.areEqual(String.valueOf(UserInfo.getUserId()), ReportsShape.cell(UserInfo.getUserId(), '-', 'id'));
        Assert.isNull(ReportsShape.cell(5, null, 'string'));
        Assert.isNull(ReportsShape.groupLabel('-'));
        Assert.areEqual('Won', ReportsShape.groupLabel('Won'));
        Assert.areEqual(2000, ReportsShape.inOrgCeiling(25));
        Assert.areEqual(500, ReportsShape.inOrgCeiling(100));
        Assert.areEqual(2000, ReportsShape.inOrgCeiling(0));
        ReportsShape.guardHeap();
    }

    class BoomException extends Exception {}

    @IsTest
    static void mapsErrorsAsTheLocalServerDoes() {
        Assert.areEqual(400, ReportsApi.failure(new ReportsCombine.CombineException('x')).status);
        Assert.areEqual(500, ReportsApi.failure(new BoomException('x')).status);
        Assert.areEqual('UNEXPECTED', errorCode(ReportsApi.failure(new BoomException())));
        Assert.areEqual(400, ReportsApi.failure(new JSONException('x')).status);
        Assert.areEqual(500, ReportsApi.failure(new NoAccessException()).status);
        Assert.areEqual(400, ReportsApi.failure(new Reports.InvalidFilterException('bad filter')).status);
        Assert.areEqual('INVALID_FILTER', errorCode(ReportsApi.failure(new Reports.InvalidFilterException('bad filter'))));
        Assert.isNotNull(ReportsApi.hintFor(404, 'X', 'y'));
        Assert.isNotNull(ReportsApi.hintFor(400, 'X', 'unknown column'));
        Assert.isNotNull(ReportsApi.hintFor(400, 'X', 'over the limit'));
        Assert.isNotNull(ReportsApi.hintFor(400, 'X', 'no permission'));
        Assert.isNull(ReportsApi.hintFor(400, 'X', 'y'));
        Assert.areEqual('a\\_b\\%c\\\'d\\\\', ReportsApi.soqlLike('a_b%c\'d\\'));
        Assert.areEqual('2026-10-11T21:06:12.000+0000', ReportsApi.soqlDatetime(Datetime.newInstanceGmt(2026, 10, 11, 21, 6, 12)));
        Assert.isNull(ReportsApi.soqlDatetime(null));
    }
}
