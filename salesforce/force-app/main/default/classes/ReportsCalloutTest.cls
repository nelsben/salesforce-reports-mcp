/**
 * The callout tools (list_report_types, describe_report_type, query_report, combine_reports with definitions) against
 * HttpCalloutMock answers shaped like the REST API's. Public so ReportsApiTest can use the mock. Creates nothing.
 */
@IsTest
public class ReportsCalloutTest {
    /**
     * Answers each call by its path after /services/data/v62.0, without the query string, and any other path with the
     * fallback (404 NOT_FOUND unless set). A status of -1 throws.
     */
    public class Mock implements HttpCalloutMock {
        Integer otherStatus = 404;
        String otherBody = '[{"errorCode":"NOT_FOUND","message":"The requested resource does not exist"}]';
        Map<String, Integer> statuses = new Map<String, Integer>();
        Map<String, String> bodies = new Map<String, String>();
        public List<HttpRequest> requests = new List<HttpRequest>();

        public Mock route(String path, Integer status, String body) {
            statuses.put(path, status);
            bodies.put(path, body);
            return this;
        }

        public HttpResponse respond(HttpRequest req) {
            requests.add(req);
            String path = req.getEndpoint().substringAfter(ReportsCallout.API_PATH).substringBefore('?');
            if (statuses.get(path) == -1) throw new CalloutException('Read timed out');
            HttpResponse res = new HttpResponse();
            res.setStatusCode(statuses.containsKey(path) ? statuses.get(path) : otherStatus);
            res.setBody(statuses.containsKey(path) ? bodies.get(path) : otherBody);
            return res;
        }
    }

    /** Every call answers 401 INVALID_SESSION_ID, as a sign-in without API access would. */
    public static Mock refusing() {
        Mock m = new Mock();
        m.otherStatus = 401;
        m.otherBody = SESSION_ERROR;
        return m;
    }

    static final String SESSION_ERROR = '[{"errorCode":"INVALID_SESSION_ID","message":"Session expired or invalid"}]';

    static final String TYPES = '[{"label":"Opportunities","reportTypes":['
        + '{"type":"Opportunity","label":"Opportunities","description":"Opportunity reports","isHidden":false},'
        + '{"type":"OpportunityHistory","label":"Opportunity History","description":null}]},'
        + '{"label":"Accounts & Contacts","reportTypes":[{"type":"AccountList","label":"Accounts","description":"All accounts"}]}]';

    static final String DESCRIBE = '{"reportMetadata":{"reportType":{"type":"Opportunity","label":"Opportunities"},"detailColumns":["STAGE_NAME","OPPORTUNITY_NAME","AMOUNT"]},'
        + '"reportTypeMetadata":{"categories":['
        + '{"label":"Opportunity Information","columns":{"OPPORTUNITY_NAME":{"label":"Opportunity Name","dataType":"string"},"AMOUNT":{"label":"Amount","dataType":"currency"},"CLOSE_DATE":{"label":"Close Date","dataType":"date"}}},'
        + '{"label":"Account Information","columns":{"ACCOUNT_NAME":{"label":"Account Name","dataType":"string"},"ACCOUNT_CREATED":{"label":"Created","dataType":"datetime"}}}],'
        + '"standardDateFilterDurationGroups":[{"label":"Fiscal Year","standardDateFilterDurations":[{"label":"Current FY","value":"THIS_FISCAL_YEAR"},{"label":"Previous FY","value":"LAST_FISCAL_YEAR"}]}],'
        + '"dateGranularityInfos":[{"label":"Day","value":"Day"},{"label":"Month","value":"Month"}],'
        + '"dataTypeFilterOperatorMap":{"string":[{"label":"equals","name":"equals"},{"label":"contains","name":"contains"}],"currency":[{"label":"equals","name":"equals"},{"label":"greater than","name":"greaterThan"}]},'
        + '"scopeInfo":{"defaultValue":"user","values":[{"label":"My opportunities","value":"user"},{"label":"All opportunities","value":"organization"}]}}}';

    static final String EXTENDED = '"reportExtendedMetadata":{'
        + '"detailColumnInfo":{"OPPORTUNITY_NAME":{"label":"Opportunity Name","dataType":"string"},"AMOUNT":{"label":"Amount","dataType":"currency"},"CLOSE_DATE":{"label":"Close Date","dataType":"date"},"IS_WON":{"label":"Won","dataType":"boolean"}},'
        + '"groupingColumnInfo":{"STAGE_NAME":{"label":"Stage","dataType":"picklist","groupingLevel":0},"TYPE":{"label":"Type","dataType":"picklist"},"CLOSE_DATE":{"label":"Close Date","dataType":"date"}},'
        + '"aggregateColumnInfo":{"s!AMOUNT":{"label":"Sum of Amount","dataType":"currency"},"RowCount":{"label":"Record Count","dataType":"int"}}}';

    static final String SUMMARY = '{"attributes":{"reportId":null,"reportName":null},"allData":true,'
        + '"reportMetadata":{"name":null,"id":null,"reportFormat":"SUMMARY","reportType":{"type":"Opportunity","label":"Opportunities"},'
        + '"detailColumns":["OPPORTUNITY_NAME","AMOUNT","CLOSE_DATE","IS_WON"],"groupingsDown":[{"name":"STAGE_NAME","sortOrder":"Asc","dateGranularity":"None"}],"groupingsAcross":[],'
        + '"aggregates":["s!AMOUNT","RowCount"],"reportFilters":[{"column":"AMOUNT","operator":"greaterThan","value":"0"}],"reportBooleanFilter":null,'
        + '"standardDateFilter":{"column":"CLOSE_DATE","durationValue":"CUSTOM","startDate":null,"endDate":null},"scope":"organization","standardFilters":[{"name":"open","value":"all"}]},'
        + EXTENDED + ','
        + '"groupingsDown":{"groupings":[{"key":"0","label":"Closed Won","value":"Closed Won","groupings":[]},{"key":"1","label":"-","value":null,"groupings":[]}]},"groupingsAcross":{"groupings":[]},'
        + '"factMap":{'
        + '"0!T":{"aggregates":[{"label":"$300.00","value":300},{"label":"2","value":2}],"rows":['
        + '{"dataCells":[{"label":"Opp 1","value":"006000000000001AAA"},{"label":"$100.00","value":{"amount":100,"currency":null}},{"label":"1/2/2026","value":"2026-01-02"},{"label":"true","value":true}]},'
        + '{"dataCells":[{"label":"Opp 2","value":"006000000000002AAA"},{"label":"-","value":{"amount":null,"currency":null}},{"label":"-","value":null},{"label":"false","value":"false"}]}]},'
        + '"1!T":{"aggregates":[{"label":"$50.00","value":50},{"label":"1","value":1}],"rows":['
        + '{"dataCells":[{"label":"-","value":"x"},{"label":"$50.00","value":{"amount":50,"currency":"USD"}},{"label":"1/3/2026","value":"2026-01-03"},{"label":"yes","value":"maybe"}]}]},'
        + '"T!T":{"aggregates":[{"label":"$350.00","value":350},{"label":"3","value":3}],"rows":[]}}}';

    static final String MATRIX = '{"allData":true,'
        + '"reportMetadata":{"reportFormat":"MATRIX","reportType":{"type":"Opportunity"},"detailColumns":["AMOUNT"],'
        + '"groupingsDown":[{"name":"STAGE_NAME"}],"groupingsAcross":[{"name":"TYPE"},{"name":"CLOSE_DATE"}],"aggregates":["RowCount"],"reportFilters":[]},'
        + EXTENDED + ','
        + '"groupingsDown":{"groupings":[{"key":"0","label":"Closed Won","groupings":[]}]},'
        + '"groupingsAcross":{"groupings":[{"key":"0","label":"New","groupings":[{"key":"0_0","label":"Q1","groupings":[]},{"key":"0_1","label":"Q2","groupings":[]}]}]},'
        + '"factMap":{"0!0_0":{"aggregates":[{"label":"1","value":1}]},"T!T":{"aggregates":[{"label":"1","value":1}]}}}';

    static final String TABULAR = '{"allData":false,"attributes":{"reportId":"00O000000000001AAA","reportName":"Saved"},'
        + '"reportMetadata":{"reportFormat":"TABULAR","reportType":{"type":"Opportunity"},"detailColumns":["OPPORTUNITY_NAME"],"groupingsDown":[],"groupingsAcross":[],"aggregates":["RowCount"]},'
        + EXTENDED + ','
        + '"factMap":{"T!T":{"aggregates":[{"label":"2","value":2}],"rows":[{"dataCells":[{"label":"Opp 1","value":"006000000000001AAA"}]},{"dataCells":[{"label":"Opp 2","value":"006000000000002AAA"}]}]}}}';

    static ReportsApi.Answer call(String tool, String body) {
        return ReportsApi.handle(tool, body);
    }

    static Map<String, Object> ok(ReportsApi.Answer a) {
        Assert.areEqual(200, a.status, JSON.serialize(a.body));
        return (Map<String, Object>) a.body;
    }

    static Map<String, Object> error(ReportsApi.Answer a) {
        return (Map<String, Object>) ((Map<String, Object>) a.body).get('error');
    }

    static Mock use(Mock m) {
        Test.setMock(HttpCalloutMock.class, m);
        return m;
    }

    @IsTest
    static void listsReportTypes() {
        Mock m = use(new Mock().route('/analytics/reportTypes', 200, TYPES));
        Map<String, Object> all = ok(call('list_report_types', '{}'));
        Assert.areEqual(3, all.get('total'));
        Assert.areEqual(3, all.get('shown'));
        Map<String, Object> first = (Map<String, Object>) ((List<Object>) all.get('types'))[0];
        Assert.areEqual('Opportunity', first.get('type'));
        Assert.areEqual('Opportunities', first.get('category'));
        Assert.isTrue(first.containsKey('description'));
        Map<String, Object> searched = ok(call('list_report_types', '{"search":" OPPORTUNIT ","limit":1}'));
        Assert.areEqual(2, searched.get('total'));
        Assert.areEqual(1, searched.get('shown'));
        Map<String, Object> byCategory = ok(call('list_report_types', '{"search":"contacts"}'));
        Assert.areEqual(1, byCategory.get('total'));
        Assert.areEqual(400, call('list_report_types', '{"limit":501}').status);
        Assert.areEqual(400, call('list_report_types', '{"search":5}').status);
        HttpRequest sent = m.requests[0];
        Assert.areEqual('GET', sent.getMethod());
        Assert.areEqual(URL.getOrgDomainUrl().toExternalForm().removeEnd('/') + '/services/data/v62.0/analytics/reportTypes', sent.getEndpoint());
        Assert.isTrue(sent.getHeader('Authorization').startsWith('Bearer '));
    }

    @IsTest
    static void listsNoTypesFromAnEmptyBody() {
        use(new Mock().route('/analytics/reportTypes', 204, ''));
        Assert.areEqual(0, ok(call('list_report_types', null)).get('total'));
    }

    @IsTest
    static void readsANullBodyAsNoInput() {
        Mock m = use(new Mock().route('/analytics/reportTypes', 200, TYPES));
        ok(call('list_report_types', 'null'));
        Assert.areEqual(1, m.requests.size());
        ReportsApi.Answer hosted = ReportsApi.handle('list_report_types', 'null', true);
        Assert.areEqual('CALLOUT_SESSION', error(hosted).get('code'));
        Assert.areEqual(1, m.requests.size(), 'no callout on the hosted route');
        Assert.areEqual(400, call('list_report_types', '[]').status);
        Assert.areEqual(400, call('list_report_types', '"x"').status);
    }

    @IsTest
    static void describesAReportTypeThroughTheRestApi() {
        use(new Mock().route('/analytics/reportTypes/Opportunity', 200, DESCRIBE));
        Map<String, Object> d = ok(call('describe_report_type', '{"type":"Opportunity"}'));
        Assert.areEqual('Opportunity', d.get('type'));
        Assert.areEqual('Opportunities', d.get('label'));
        Assert.areEqual(5, d.get('fieldCount'));
        Assert.areEqual(5, d.get('fieldsShown'));
        List<Object> sections = (List<Object>) d.get('sections');
        Assert.areEqual(2, sections.size());
        List<Object> fields = (List<Object>) ((Map<String, Object>) sections[0]).get('fields');
        // The fields keep the order REST lists them in.
        Assert.areEqual('OPPORTUNITY_NAME', ((Map<String, Object>) fields[0]).get('name'));
        Assert.areEqual('CLOSE_DATE', ((Map<String, Object>) fields[2]).get('name'));
        Assert.areEqual(2, ((List<Object>) d.get('dateFilterColumns')).size());
        Assert.areEqual(new List<Object>{ 'THIS_FISCAL_YEAR', 'LAST_FISCAL_YEAR' }, d.get('dateFilterDurations'));
        Assert.areEqual(new List<Object>{ 'Day', 'Month' }, d.get('dateGranularities'));
        Map<String, Object> operators = (Map<String, Object>) d.get('filterOperators');
        Assert.areEqual(new List<Object>{ 'equals', 'greaterThan' }, operators.get('currency'));
        Assert.areEqual(new List<Object>{ 'user', 'organization' }, d.get('scopes'));
        Assert.isFalse(d.containsKey('notes'));

        Map<String, Object> searched = ok(call('describe_report_type', '{"type":"Opportunity","search":"account","limit":1}'));
        Assert.areEqual(5, searched.get('fieldCount'));
        Assert.areEqual(1, searched.get('fieldsShown'));
    }

    @IsTest
    static void passesASalesforceErrorThrough() {
        use(new Mock());
        Map<String, Object> e = error(call('describe_report_type', '{"type":"No Such"}'));
        Assert.areEqual('NOT_FOUND', e.get('code'));
        Assert.areEqual('The requested resource does not exist', e.get('message'));
        Assert.areEqual('Check the id with search_reports (reports) or list_report_types (report types).', e.get('hint'));
        Assert.areEqual(400, call('describe_report_type', '{"type":"No Such"}').status);
    }

    @IsTest
    static void fallsBackToASavedReportWhenTheSessionIsRefused() {
        use(refusing());
        ReportsApi.Answer a = call('describe_report_type', '{"type":"No_Such_Type__c"}');
        Assert.areEqual(400, a.status);
        Assert.areEqual('NO_SAVED_REPORT', error(a).get('code'));
        Assert.isTrue(((String) error(a).get('message')).contains('could not call the org\'s REST API'));
    }

    @IsTest
    static void answersCalloutSessionForARefusedSession() {
        use(refusing());
        ReportsApi.Answer a = call('list_report_types', '{}');
        Assert.areEqual(500, a.status);
        Assert.areEqual('CALLOUT_SESSION', error(a).get('code'));
        Assert.areEqual(ReportsCallout.SESSION_HINT, error(a).get('hint'));
        Assert.isTrue(((String) error(a).get('message')).contains('INVALID_SESSION_ID'));
        Assert.areEqual('CALLOUT_SESSION', error(call('query_report', '{"reportType":"Opportunity","columns":["AMOUNT"]}')).get('code'));
        // The code alone is enough, whatever the status.
        Assert.areEqual('CALLOUT_SESSION', ReportsCallout.toError(403, SESSION_ERROR, 'GET /x').code);
        // A 401 with no body is refused too.
        Assert.areEqual('CALLOUT_SESSION', ReportsCallout.toError(401, '', 'GET /x').code);
    }

    @IsTest
    static void answersCalloutSessionWithNoSession() {
        Mock m = use(new Mock().route('/analytics/reportTypes', 200, TYPES));
        ReportsCallout.noSession = true;
        ReportsApi.Answer a = call('list_report_types', '{}');
        Assert.areEqual(500, a.status);
        Assert.areEqual('CALLOUT_SESSION', error(a).get('code'));
        Assert.areEqual(0, m.requests.size());
    }

    /** The hosted MCP door's route: no session is asked for and no callout is made (docs/decisions/0007). */
    @IsTest
    static void answersCalloutSessionOnTheHostedRoute() {
        Mock m = use(new Mock().route('/analytics/reportTypes', 200, TYPES).route('/analytics/reports/query', 200, TABULAR));
        Map<String, String> bodies = new Map<String, String>{
            'list_report_types' => '{}',
            'query_report' => '{"reportType":"Opportunity","columns":["AMOUNT"]}',
            'combine_reports' => '{"mode":"stack","inputs":[{"alias":"a","definition":{"reportType":"Opportunity","columns":["OPPORTUNITY_NAME"]}},{"alias":"b","definition":{"reportType":"Opportunity","columns":["OPPORTUNITY_NAME"]}}]}'
        };
        for (String tool : bodies.keySet()) {
            ReportsApi.Answer a = ReportsApi.handle(tool, bodies.get(tool), true);
            Assert.areEqual(500, a.status, tool);
            Assert.areEqual('CALLOUT_SESSION', error(a).get('code'), tool);
            Assert.areEqual(ReportsCallout.HOSTED_MESSAGE, error(a).get('message'), tool);
            Assert.areEqual(ReportsCallout.HOSTED_HINT, error(a).get('hint'), tool);
        }
        // describe_report_type reaches its saved-report fallback.
        ReportsApi.Answer described = ReportsApi.handle('describe_report_type', '{"type":"No_Such_Type__c"}', true);
        Assert.areEqual(400, described.status);
        Assert.areEqual('NO_SAVED_REPORT', error(described).get('code'));
        Assert.areEqual(0, m.requests.size(), 'no callout on the hosted route');
        // The REST route still calls out with the session.
        ok(call('list_report_types', '{}'));
        Assert.areEqual(1, m.requests.size());
        Assert.isTrue(m.requests[0].getHeader('Authorization').startsWith('Bearer '));
    }

    @IsTest
    static void readsSalesforceErrorBodiesAsTheLocalClientDoes() {
        ReportsException e = ReportsCallout.toError(400, '[{"errorCode":"BAD_REQUEST","message":"The column NOPE is not valid."}]', 'POST /x');
        Assert.areEqual(ReportsException.ErrorCategory.INVALID_INPUT, e.category);
        Assert.areEqual('BAD_REQUEST', e.code);
        Assert.areEqual('The column NOPE is not valid.', e.getMessage());
        Assert.isTrue(e.hintText.contains('describe_report_type'));
        e = ReportsCallout.toError(500, '<html>oops</html>', 'GET /x');
        Assert.areEqual(ReportsException.ErrorCategory.FAILED, e.category);
        Assert.areEqual('HTTP_500', e.code);
        Assert.areEqual('Salesforce returned HTTP 500.', e.getMessage());
        Assert.isNull(e.hintText);
        e = ReportsCallout.toError(400, '{"error":"invalid_grant","error_description":"expired"}', 'GET /x');
        Assert.areEqual('invalid_grant', e.code);
        Assert.areEqual('expired', e.getMessage());
        e = ReportsCallout.toError(403, '[{}]', 'GET /x');
        Assert.areEqual('HTTP_403', e.code);
        Assert.areEqual('HTTP 403', e.getMessage());
        Assert.areEqual('a%20b%2Fc', ReportsCallout.segment('a b/c'));
    }

    @IsTest
    static void answersCalloutFailedWhenTheCallFails() {
        use(new Mock().route('/analytics/reportTypes', -1, null));
        Map<String, Object> e = error(call('list_report_types', '{}'));
        Assert.areEqual('CALLOUT_FAILED', e.get('code'));
        Assert.isTrue(((String) e.get('message')).contains('Read timed out'));
    }

    @IsTest
    static void queriesASummaryWithDetailRows() {
        Mock m = use(new Mock().route('/analytics/reports/query', 200, SUMMARY));
        Map<String, Object> r = ok(call('query_report', '{"reportType":"Opportunity","columns":["OPPORTUNITY_NAME","AMOUNT","CLOSE_DATE","IS_WON"],'
            + '"groupingsDown":[{"column":"STAGE_NAME"}],"aggregates":["s!AMOUNT"],"filters":[{"column":"AMOUNT","operator":"greaterThan","value":"0"}],"detail":true,"maxRows":2}'));
        HttpRequest sent = m.requests[0];
        Assert.areEqual('POST', sent.getMethod());
        Assert.isTrue(sent.getEndpoint().endsWith('/analytics/reports/query?includeDetails=true'));
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(sent.getBody());
        Map<String, Object> meta = (Map<String, Object>) body.get('reportMetadata');
        Assert.areEqual('SUMMARY', meta.get('reportFormat'));
        Assert.areEqual('Opportunity', ((Map<String, Object>) meta.get('reportType')).get('type'));

        Map<String, Object> report = (Map<String, Object>) r.get('report');
        Assert.isNull(report.get('id'));
        Assert.areEqual('Unsaved report', report.get('name'));
        Assert.areEqual('SUMMARY', report.get('format'));
        Assert.areEqual('Opportunity', report.get('reportType'));
        Assert.isFalse(report.containsKey('url'));
        List<Object> filters = (List<Object>) r.get('filters');
        Assert.areEqual('Close Date: ... to ...', filters[0]);
        Assert.areEqual('Amount greater than 0', filters[1]);
        Assert.areEqual('Scope: organization', filters[2]);
        Assert.areEqual('Standard filter open: all', filters[3]);
        Map<String, Object> totals = (Map<String, Object>) r.get('totals');
        Assert.areEqual(new List<Object>{ 's!AMOUNT', 'RowCount' }, totals.get('measures'));
        Assert.areEqual(new List<Object>{ 350, 3 }, totals.get('values'));
        Map<String, Object> groups = (Map<String, Object>) r.get('groups');
        List<Object> groupRows = (List<Object>) groups.get('rows');
        Assert.areEqual(new List<Object>{ 'Closed Won', 300, 2 }, groupRows[0]);
        Assert.areEqual(new List<Object>{ null, 50, 1 }, groupRows[1]);
        Assert.areEqual('Sum of Amount', ((Map<String, Object>) ((List<Object>) groups.get('measures'))[0]).get('label'));
        Assert.areEqual('Stage', ((Map<String, Object>) ((List<Object>) groups.get('dimensions'))[0]).get('label'));
        Map<String, Object> detail = (Map<String, Object>) r.get('detail');
        Assert.areEqual(3, detail.get('rowCount'));
        Assert.areEqual(true, detail.get('truncated'));
        List<Object> rows = (List<Object>) detail.get('rows');
        Assert.areEqual(2, rows.size());
        Assert.areEqual(new List<Object>{ 'Closed Won', 'Opp 1', 100, '2026-01-02', true }, rows[0]);
        Assert.areEqual(new List<Object>{ 'Closed Won', 'Opp 2', null, null, false }, rows[1]);
        List<Object> columns = (List<Object>) detail.get('columns');
        Assert.areEqual(5, columns.size());
        Assert.areEqual('picklist', ((Map<String, Object>) columns[0]).get('dataType'));
        Assert.areEqual('currency', ((Map<String, Object>) columns[2]).get('dataType'));
        Assert.areEqual(new List<Object>{ 'Showing 2 of 3 detail rows. Raise maxRows (up to 2000) or add filters.' }, r.get('notes'));
    }

    @IsTest
    static void queriesASummaryWithoutDetailRows() {
        Mock m = use(new Mock().route('/analytics/reports/query', 200, SUMMARY));
        Map<String, Object> r = ok(call('query_report', '{"reportType":"Opportunity","columns":["AMOUNT"],"groupingsDown":[{"column":"STAGE_NAME"}]}'));
        Assert.isTrue(m.requests[0].getEndpoint().endsWith('includeDetails=false'));
        Assert.isFalse(r.containsKey('detail'));
        Assert.areEqual(2, ((List<Object>) ((Map<String, Object>) r.get('groups')).get('rows')).size());
    }

    @IsTest
    static void queriesAMatrixWithNestedAcrossGroupings() {
        use(new Mock().route('/analytics/reports/query', 200, MATRIX));
        Map<String, Object> r = ok(call('query_report', '{"reportType":"Opportunity","columns":["AMOUNT"],"groupingsDown":[{"column":"STAGE_NAME"}],"groupingsAcross":[{"column":"TYPE"},{"column":"CLOSE_DATE"}],"detail":true}'));
        Map<String, Object> groups = (Map<String, Object>) r.get('groups');
        List<Object> rows = (List<Object>) groups.get('rows');
        // Only combinations with a fact are rows: Closed Won, New, Q1. Q2 has none.
        Assert.areEqual(1, rows.size());
        Assert.areEqual(new List<Object>{ 'Closed Won', 'New', 'Q1', 1 }, rows[0]);
        Assert.areEqual(3, ((List<Object>) groups.get('dimensions')).size());
        Assert.areEqual('across', ((Map<String, Object>) ((List<Object>) groups.get('dimensions'))[2]).get('axis'));
        // A matrix with no detail rows has no detail table.
        Assert.isFalse(r.containsKey('detail'));
        Assert.areEqual(new List<Object>{ 1 }, ((Map<String, Object>) r.get('totals')).get('values'));
    }

    @IsTest
    static void queriesATabularReportCutByAllData() {
        use(new Mock().route('/analytics/reports/query', 200, TABULAR));
        Map<String, Object> r = ok(call('query_report', '{"reportType":"Opportunity","columns":["OPPORTUNITY_NAME"]}'));
        Map<String, Object> report = (Map<String, Object>) r.get('report');
        Assert.areEqual('00O000000000001AAA', report.get('id'));
        Assert.areEqual('Saved', report.get('name'));
        Assert.isTrue(((String) report.get('url')).endsWith('/lightning/r/Report/00O000000000001AAA/view'));
        Map<String, Object> detail = (Map<String, Object>) r.get('detail');
        Assert.areEqual(2, detail.get('rowCount'));
        Assert.areEqual(true, detail.get('truncated'));
        Assert.areEqual(new List<Object>{ 'Opp 1' }, ((List<Object>) detail.get('rows'))[0]);
        Assert.isTrue(((String) ((List<Object>) r.get('notes'))[0]).contains('allData is false'));
        Assert.isFalse(r.containsKey('groups'));
    }

    @IsTest
    static void addsADetailColumnToAGroupedQuery() {
        Mock m = use(new Mock()
            .route('/analytics/reportTypes/Opportunity', 200, DESCRIBE)
            .route('/analytics/reports/query', 200, SUMMARY));
        Map<String, Object> r = ok(call('query_report', '{"reportType":"Opportunity","groupingsDown":[{"column":"STAGE_NAME"}]}'));
        Assert.areEqual(2, m.requests.size());
        Map<String, Object> meta = (Map<String, Object>) ((Map<String, Object>) JSON.deserializeUntyped(m.requests[1].getBody())).get('reportMetadata');
        Assert.areEqual(new List<Object>{ 'OPPORTUNITY_NAME' }, meta.get('detailColumns'));
        Assert.areEqual('No detail column was given, so OPPORTUNITY_NAME was added; Salesforce needs one on a grouped report.', ((List<Object>) r.get('notes'))[0]);
    }

    @IsTest
    static void refusesAGroupedQueryWithNoColumnToAdd() {
        use(new Mock().route('/analytics/reportTypes/Opportunity', 200, '{"reportMetadata":{"detailColumns":["STAGE_NAME"]}}'));
        ReportsApi.Answer a = call('query_report', '{"reportType":"Opportunity","groupingsDown":[{"column":"STAGE_NAME"}]}');
        Assert.areEqual(400, a.status);
        Assert.areEqual('Give at least one detail column that is not a grouping.', error(a).get('message'));
    }

    @IsTest
    static void refusesAQueryWithoutAReportType() {
        Mock m = use(new Mock());
        ReportsApi.Answer a = call('query_report', '{"columns":["AMOUNT"]}');
        Assert.areEqual(400, a.status);
        Assert.areEqual('INVALID_INPUT', error(a).get('code'));
        Assert.areEqual('A report defined in the call needs reportType. Find one with list_report_types.', error(a).get('message'));
        Assert.areEqual(400, call('query_report', '{"reportType":"Opportunity","maxRows":0}').status);
        Assert.areEqual(0, m.requests.size());
    }

    @IsTest
    static void passesAQueryErrorThrough() {
        use(new Mock().route('/analytics/reports/query', 400, '[{"errorCode":"BAD_REQUEST","message":"The column NOPE is not valid."}]'));
        ReportsApi.Answer a = call('query_report', '{"reportType":"Opportunity","columns":["NOPE"]}');
        Assert.areEqual(400, a.status);
        Assert.areEqual('BAD_REQUEST', error(a).get('code'));
        Assert.areEqual('The column NOPE is not valid.', error(a).get('message'));
    }

    @IsTest
    static void combinesDefinitions() {
        Mock m = use(new Mock().route('/analytics/reports/query', 200, TABULAR));
        Map<String, Object> r = ok(call('combine_reports', '{"mode":"stack","detail":true,"inputs":['
            + '{"alias":"a","definition":{"reportType":"Opportunity","columns":["OPPORTUNITY_NAME"]}},'
            + '{"alias":"b","definition":{"reportType":"Opportunity","columns":["OPPORTUNITY_NAME"]}}]}'));
        Assert.areEqual(2, m.requests.size());
        Assert.isNotNull(r.get('report'));
        Assert.areEqual(400, call('combine_reports', '{"mode":"stack","inputs":[{"alias":"a","definition":5},{"alias":"b","definition":{}}]}').status);
    }

    @IsTest
    static void shapesRestCurrencyCells() {
        Assert.areEqual(12.5, ReportsShape.cell(new Map<String, Object>{ 'amount' => 12.5, 'currency' => 'USD' }, '$12.50', 'currency'));
        Assert.isNull(ReportsShape.cell(new Map<String, Object>{ 'amount' => null }, '-', 'currency'));
        Assert.areEqual('x', ReportsShape.cell(new Map<String, Object>{ 'currency' => 'USD' }, 'x', 'currency'));
        Assert.areEqual('', ReportsShape.cell(new Map<String, Object>{ 'currency' => 'USD' }, null, 'currency'));
        ReportsException tooLarge = ReportsShape.tooLarge();
        Assert.areEqual(ReportsException.ErrorCategory.FAILED, tooLarge.category);
        Assert.areEqual('RESULT_TOO_LARGE', tooLarge.code);
    }
}
