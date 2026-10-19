/**
 * The dashboard tools (list_dashboards, describe_dashboard, run_dashboard, refresh_dashboard) through the REST door,
 * against HttpCalloutMock answers trimmed from the dashboard fixtures, with neutral names. The list rows are built in
 * memory, except in one SeeAllData test that lists the org's own dashboards with every /status call mocked. The refresh
 * tests run as the running user with the Salesforce_Reports_Write permission set (assigned in the test setup when
 * missing), and as a Chatter Free reader without it; both roll back with the test. Creates nothing.
 */
@IsTest
private class ReportsDashboardsTest {
    static final String ID = '01Z000000000017AAA';
    static final String BASE = '/analytics/dashboards/' + ID;

    static final String COMPONENTS = '"layout":{"numColumns":12,"components":['
        + '{"row":0,"column":6,"rowspan":4,"colspan":3},{"row":0,"column":0,"rowspan":4,"colspan":3},{"row":4,"column":0,"rowspan":4,"colspan":6},{"row":4,"column":6,"rowspan":4,"colspan":6}]},'
        + '"components":['
        + '{"id":"01a000000000006AAA","header":"Gauge","title":null,"footer":"Target","reportId":"00O000000000004AAA","properties":{"visualizationType":"Gauge","aggregates":[{"name":"s!AMOUNT"}],"filterColumns":[{"name":"STAGE_NAME"}],'
        + '"visualizationProperties":{"breakPoints":[{"aggregateName":"s!AMOUNT","breaks":[{"color":"c25454","lowerBound":0,"upperBound":2000000},{"color":"c2c254","lowerBound":2000000,"upperBound":4000000},{"color":"54C254","lowerBound":4000000,"upperBound":5000000}]}]}}},'
        + '{"id":"01a000000000001AAA","header":"Won to Date","title":null,"footer":null,"reportId":"00O000000000002AAA","properties":{"visualizationType":"Metric","aggregates":[{"name":"s!AMOUNT"}],"filterColumns":[],'
        + '"visualizationProperties":{"metricLabel":"Closed Won amount","colorPalette":"bluegrass"}}},'
        + '{"id":"01a000000000003AAA","header":"By Stage","title":null,"footer":null,"reportId":"00O000000000003AAA","properties":{"visualizationType":"Bar","groupings":[{"name":"STAGE_NAME"}],"aggregates":[{"name":"RowCount"}],"filterColumns":[{"name":"STAGE_NAME"}]}},'
        + '{"id":"01a000000000011AAA","header":null,"title":"Deals","footer":null,"reportId":"00O000000000005AAA","properties":{"visualizationType":"Table","aggregates":[{"name":"mx!AMOUNT"}]}}]';

    static final String FILTERS = '"filters":[{"name":"Stage","dataType":"picklist","id":"0IB000000000012AAA","options":['
        + '{"id":"0IC000000000013AAA","value":"Prospecting","alias":null},'
        + '{"id":"0IC000000000014AAA","value":"Closed Won","alias":"Won"},'
        + '{"id":"0IC000000000015AAA","value":null,"startValue":"1","endValue":"5"}]}]';

    static final String META = '{"id":"' + ID + '","name":"Pipeline Overview","developerName":"Pipeline_Overview","description":null,'
        + '"folderId":"00l000000000016AAA","folderName":"Dashboards 1","dashboardType":"SpecifiedUser","colorPalette":"unity",'
        + '"runningUser":{"displayName":"User 1","id":"005000000000018AAA"},"owner":{"displayName":"User 1","id":"005000000000018AAA"},'
        + FILTERS + ',' + COMPONENTS + '}';

    static final String NO_FILTERS = '{"id":"' + ID + '","name":"Pipeline Overview","filters":[],' + COMPONENTS + '}';

    static String reportResult(String reportId) {
        return '{"attributes":null,"allData":true,"factMap":{"T!T":{"aggregates":[{"label":"$3,629,000.00","value":3629000}]}},'
            + '"groupingsAcross":{"groupings":[]},"groupingsDown":{"groupings":[]},'
            + '"reportExtendedMetadata":{"aggregateColumnInfo":{"s!AMOUNT":{"dataType":"currency","label":"Sum of Amount"}},"detailColumnInfo":{},"groupingColumnInfo":{}},'
            + '"reportMetadata":{"aggregates":["s!AMOUNT"],"detailColumns":[],"groupingsAcross":[],"groupingsDown":[],"id":"' + reportId + '","name":"Report 1",'
            + '"reportFilters":[],"reportFormat":"SUMMARY","reportType":{"label":"Opportunities","type":"Opportunity"},"standardFilters":[{"name":"open","value":"all"}]}}';
    }

    /** Two components with data (one stale), one never refreshed and one failed. */
    static final String RESULTS = '{"attributes":{"dashboardId":"' + ID + '","dashboardName":"Pipeline Overview"},"dashboardMetadata":' + META + ',"componentData":['
        + '{"componentId":"01a000000000001AAA","status":{"componentDataStatus":"DATA","errorCode":null,"refreshDate":"2026-10-15T02:13:35.000+0000","refreshStatus":"IDLE"},"reportResult":' + reportResult('00O000000000002AAA') + '},'
        + '{"componentId":"01a000000000006AAA","status":{"componentDataStatus":"DATA","errorCode":null,"refreshDate":"2026-10-15T02:13:30.000+0000","refreshStatus":"STALE"},"reportResult":' + reportResult('00O000000000004AAA') + '},'
        + '{"componentId":"01a000000000003AAA","status":{"componentDataStatus":"NO_DATA","refreshDate":null,"refreshStatus":"IDLE"},"reportResult":null},'
        + '{"componentId":"01a000000000011AAA","status":{"componentDataStatus":"ERROR","errorCode":"FAILED","errorMessage":"Something broke"},"reportResult":null}]}';

    /** A filter option never refreshed: no component has data. */
    static final String NO_DATA = '{"dashboardMetadata":' + META + ',"componentData":['
        + '{"componentId":"01a000000000001AAA","status":{"componentDataStatus":"NO_DATA"},"reportResult":null},'
        + '{"componentId":"01a000000000006AAA","status":{"componentDataStatus":"NO_DATA"},"reportResult":null},'
        + '{"componentId":"01a000000000003AAA","status":{"componentDataStatus":"NO_DATA"},"reportResult":null},'
        + '{"componentId":"01a000000000011AAA","status":{"componentDataStatus":"NO_DATA"},"reportResult":null}]}';

    static final String STATUS = '{"componentStatus":[{"componentId":"01a000000000001AAA","componentDataStatus":"DATA","refreshDate":"2026-10-17T02:13:35.000+0000","refreshStatus":"IDLE"},'
        + '{"componentId":"01a000000000003AAA","componentDataStatus":"DATA","refreshDate":"2026-10-17T03:00:00.000+0000","refreshStatus":"IDLE"},'
        + '{"componentId":"01a000000000006AAA","componentDataStatus":"NO_DATA","refreshDate":null}]}';

    static final String NEVER = '{"componentStatus":[{"componentId":"01a000000000001AAA","componentDataStatus":"NO_DATA","refreshDate":null}]}';
    static final String NOT_FOUND = '[{"errorCode":"NOT_FOUND","message":"The requested resource does not exist"}]';

    /**
     * Answers by the path after /services/data/v62.0 with its query string, then without it, then '*' + '/status' for
     * any status path. Anything else answers the fallback.
     */
    class Mock implements HttpCalloutMock {
        Map<String, Integer> statuses = new Map<String, Integer>();
        Map<String, String> bodies = new Map<String, String>();
        Integer otherStatus = 404;
        String otherBody = NOT_FOUND;
        List<String> paths = new List<String>();
        List<String> methods = new List<String>();
        List<String> sentBodies = new List<String>();
        /** Answers for successive /status calls; the last one repeats. Used before the '*' + '/status' route. */
        List<String> statusSequence = new List<String>();
        Integer statusCalls = 0;

        Mock route(String key, Integer status, String body) {
            statuses.put(key, status);
            bodies.put(key, body);
            return this;
        }

        public HttpResponse respond(HttpRequest req) {
            String full = req.getEndpoint().substringAfter(ReportsCallout.API_PATH);
            paths.add(full);
            methods.add(req.getMethod());
            sentBodies.add(req.getBody());
            String path = full.substringBefore('?');
            if (req.getMethod() == 'GET' && path.endsWith('/status') && !statusSequence.isEmpty()) {
                HttpResponse seq = new HttpResponse();
                String next = statusSequence[Math.min(statusCalls, statusSequence.size() - 1)];
                // An entry that starts with 'E:' answers HTTP 500 with the rest as its body.
                seq.setStatusCode(next.startsWith('E:') ? 500 : 200);
                seq.setBody(next.removeStart('E:'));
                statusCalls++;
                return seq;
            }
            String verb = req.getMethod() + ' ';
            String key = statuses.containsKey(verb + full) ? verb + full : (statuses.containsKey(verb + path) ? verb + path : null);
            if (key == null) key = statuses.containsKey(full) ? full : (statuses.containsKey(path) ? path : (path.endsWith('/status') && statuses.containsKey('*/status') ? '*/status' : null));
            HttpResponse res = new HttpResponse();
            res.setStatusCode(key == null ? otherStatus : statuses.get(key));
            res.setBody(key == null ? otherBody : bodies.get(key));
            return res;
        }
    }

    static Mock use(Mock m) {
        Test.setMock(HttpCalloutMock.class, m);
        return m;
    }

    static ReportsApi.Answer call(String tool, String body) {
        return ReportsApi.handle(tool, body);
    }

    /** The body as the wire carries it, read back. */
    static Map<String, Object> ok(ReportsApi.Answer a) {
        Assert.areEqual(200, a.status, JSON.serialize(a.body));
        return (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(a.body));
    }

    static Map<String, Object> error(ReportsApi.Answer a) {
        return (Map<String, Object>) ((Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(a.body))).get('error');
    }

    static Map<String, Object> at(List<Object> items, Integer i) {
        return (Map<String, Object>) items[i];
    }

    static List<Object> items(Map<String, Object> m, String key) {
        return (List<Object>) m.get(key);
    }

    static Map<String, Object> child(Map<String, Object> m, String key) {
        return (Map<String, Object>) m.get(key);
    }

    @IsTest
    static void describesInLayoutOrder() {
        use(new Mock().route(BASE + '/describe', 200, META));
        Map<String, Object> out = ok(call('describe_dashboard', '{"dashboardId":"' + ID + '"}'));
        Assert.areEqual(ID, out.get('id'));
        Assert.areEqual('Pipeline Overview', out.get('name'));
        Assert.areEqual('Pipeline_Overview', out.get('developerName'));
        Assert.isTrue(out.containsKey('description'));
        Assert.areEqual('Dashboards 1', child(out, 'folder').get('name'));
        Assert.areEqual('SpecifiedUser', out.get('type'));
        Assert.areEqual('User 1: the dashboard always runs as this user, so every viewer sees the same data.', out.get('runningUser'));
        Assert.areEqual('User 1', out.get('owner'));
        Assert.isTrue(((String) out.get('url')).endsWith('/lightning/r/Dashboard/' + ID + '/view'));
        Map<String, Object> filter = at(items(out, 'filters'), 0);
        Assert.areEqual('Stage', filter.get('name'));
        Assert.areEqual('picklist', filter.get('dataType'));
        Assert.areEqual(new List<Object>{ 'Prospecting', 'Won', '1 to 5' }, filter.get('options'));
        Assert.areEqual('Components are listed in layout order: top to bottom, then left to right, on a grid 12 columns wide.', out.get('layout'));

        List<Object> components = items(out, 'components');
        Assert.areEqual(4, components.size());
        List<String> order = new List<String>();
        for (Object c : components) order.add((String) ((Map<String, Object>) c).get('id'));
        Assert.areEqual(new List<String>{ '01a000000000001AAA', '01a000000000006AAA', '01a000000000003AAA', '01a000000000011AAA' }, order);
        Map<String, Object> metric = at(components, 0);
        Assert.areEqual('Metric', metric.get('visualizationType'));
        Assert.areEqual(new Map<String, Object>{ 'row' => 0, 'column' => 0, 'rows' => 4, 'columns' => 3 }, metric.get('position'));
        Map<String, Object> report = child(metric, 'report');
        Assert.areEqual('00O000000000002AAA', report.get('id'));
        Assert.isTrue(report.containsKey('name'), 'the name is null when this user cannot read the report');
        Assert.isTrue(((String) report.get('url')).endsWith('/lightning/r/Report/00O000000000002AAA/view'));
        Assert.areEqual(new Map<String, Object>{ 'name' => 's!AMOUNT', 'label' => 'Sum of Amount' }, at(items(metric, 'measures'), 0));
        Map<String, Object> bar = at(components, 2);
        Assert.areEqual(new List<Object>{ 'STAGE_NAME' }, bar.get('groupings'));
        Assert.areEqual('Record Count', at(items(bar, 'measures'), 0).get('label'));
        Assert.areEqual('Largest Amount', at(items(at(components, 3), 'measures'), 0).get('label'));
        Assert.areEqual('Target', at(components, 1).get('footer'));
    }

    @IsTest
    static void runsTheCacheWithEverythingTheCardDraws() {
        Mock m = use(new Mock().route(BASE, 200, RESULTS));
        ReportsDashboards.clock = Datetime.newInstanceGmt(2026, 10, 18, 3, 0, 0);
        Map<String, Object> out = ok(call('run_dashboard', '{"dashboardId":"' + ID + '"}'));
        Assert.areEqual(new List<String>{ BASE }, m.paths, 'no describe without filters');
        Map<String, Object> dashboard = child(out, 'dashboard');
        Assert.areEqual(ID, dashboard.get('id'));
        Assert.areEqual('Pipeline Overview', dashboard.get('name'));
        Assert.areEqual('00l000000000016AAA', child(dashboard, 'folder').get('id'));
        Assert.isTrue(((String) dashboard.get('url')).endsWith('/lightning/r/Dashboard/' + ID + '/view'));
        Assert.areEqual(new List<Object>{ 'Stage: all (no option chosen)' }, out.get('filters'));
        Assert.areEqual('2026-10-15T02:13:30.000+0000', out.get('refreshedAt'), 'the oldest refresh among the components with data');
        Assert.areEqual('unity', out.get('colorPalette'));

        List<Object> components = items(out, 'components');
        Map<String, Object> metric = at(components, 0);
        Assert.areEqual('data', metric.get('status'));
        Assert.areEqual('2026-10-15T02:13:35.000+0000', metric.get('refreshedAt'));
        Map<String, Object> result = child(metric, 'result');
        Assert.areEqual('00O000000000002AAA', child(result, 'report').get('id'));
        Assert.areEqual(new Map<String, Object>{ 'measures' => new List<Object>{ 's!AMOUNT' }, 'values' => new List<Object>{ 3629000 } }, result.get('totals'));
        Assert.isFalse(items(result, 'filters').contains('Dashboard filter Stage: Prospecting'));
        Assert.areEqual('00O000000000002AAA', child(metric, 'sourceReport').get('id'));
        Assert.isTrue(((String) child(metric, 'sourceReport').get('url')).endsWith('/lightning/r/Report/00O000000000002AAA/view'));
        Assert.areEqual(new Map<String, Object>{ 'name' => 's!AMOUNT', 'label' => 'Sum of Amount', 'dataType' => 'currency' }, metric.get('measure'));
        Assert.areEqual('Closed Won amount', metric.get('metricLabel'));
        Assert.areEqual('bluegrass', metric.get('colorPalette'));
        Assert.isFalse(metric.containsKey('gauge'));
        Assert.isFalse(metric.containsKey('error'));

        Map<String, Object> gauge = at(components, 1);
        Assert.areEqual(new Map<String, Object>{
            'min' => 0, 'max' => 5000000, 'breakpoints' => new List<Object>{ 2000000, 4000000 }, 'colors' => new List<Object>{ '#c25454', '#c2c254', '#54c254' }
        }, gauge.get('gauge'));
        Assert.isFalse(gauge.containsKey('metricLabel'));

        Map<String, Object> bar = at(components, 2);
        Assert.areEqual('no data', bar.get('status'));
        Assert.isFalse(bar.containsKey('result'));
        Assert.areEqual(new Map<String, Object>{ 'name' => 'RowCount', 'label' => 'Record Count', 'dataType' => 'int' }, bar.get('measure'));

        Map<String, Object> table = at(components, 3);
        Assert.areEqual('error', table.get('status'));
        Assert.areEqual(new Map<String, Object>{ 'code' => 'FAILED', 'message' => 'Something broke' }, table.get('error'));
        Assert.areEqual(new Map<String, Object>{ 'name' => 'mx!AMOUNT', 'label' => 'mx!AMOUNT', 'dataType' => 'number' }, table.get('measure'));

        List<Object> notes = items(out, 'notes');
        Assert.areEqual('1 of 4 components have no data (By Stage). Call refresh_dashboard with the same filters to fill them.', notes[0]);
        Assert.areEqual('Deals failed in Salesforce: FAILED: Something broke', notes[1]);
        Assert.areEqual('Salesforce marks this data stale: the dashboard was refreshed since with other filters. These numbers are from 2026-10-15T02:13:30.000+0000; call refresh_dashboard with the same filters for current ones.', notes[2]);
        Assert.areEqual('These numbers were refreshed 3 days ago, at 2026-10-15T02:13:30.000+0000. Call refresh_dashboard for current ones.', notes[3]);
        Assert.areEqual(4, notes.size(), JSON.serialize(notes));
    }

    @IsTest
    static void runsWithAFilterByNameAndLabel() {
        Mock m = use(new Mock().route(BASE + '/describe', 200, META).route(BASE + '?filter1=0IC000000000014AAA', 200, NO_DATA));
        Map<String, Object> out = ok(call('run_dashboard', '{"dashboardId":"' + ID + '","filters":[{"name":" stage ","option":"WON"}],"maxRows":5}'));
        Assert.areEqual(new List<String>{ BASE + '/describe', BASE + '?filter1=0IC000000000014AAA' }, m.paths, 'describe first, then the option id on the query string');
        Assert.areEqual(new List<Object>{ 'Stage: Won' }, out.get('filters'));
        Assert.isNull(out.get('refreshedAt'));
        Assert.areEqual(new List<Object>{ 'No component has data for Stage: Won: the dashboard has not been refreshed with these filters. Call refresh_dashboard with the same filters to get numbers.' }, out.get('notes'));
    }

    @IsTest
    static void addsTheDashboardFilterToAFilteredComponent() {
        use(new Mock().route(BASE + '/describe', 200, META).route(BASE + '?filter1=0IC000000000013AAA', 200, RESULTS));
        ReportsDashboards.clock = Datetime.newInstanceGmt(2026, 10, 15, 3, 0, 0);
        Map<String, Object> out = ok(call('run_dashboard', '{"dashboardId":"' + ID + '","filters":[{"name":"Stage","option":"0IC000000000013AAA"}]}'));
        List<Object> components = items(out, 'components');
        Assert.isTrue(items(child(at(components, 1), 'result'), 'filters').contains('Dashboard filter Stage: Prospecting'), 'the gauge has filterColumns');
        Assert.isFalse(items(child(at(components, 0), 'result'), 'filters').contains('Dashboard filter Stage: Prospecting'), 'the metric has none');
        for (Object n : items(out, 'notes')) Assert.isFalse(((String) n).contains('days ago'), 'refreshed under a day ago');
        Assert.isTrue(((String) items(out, 'notes')[0]).contains('have no data for Stage: Prospecting (By Stage)'));
    }

    @IsTest
    static void refusesBadFiltersBeforeAnyDataCall() {
        Mock m = use(new Mock().route(BASE + '/describe', 200, META));
        ReportsApi.Answer unknownName = call('run_dashboard', '{"dashboardId":"' + ID + '","filters":[{"name":"Region","option":"West"}]}');
        Assert.areEqual(400, unknownName.status);
        Assert.areEqual('INVALID_INPUT', error(unknownName).get('code'));
        Assert.areEqual('No dashboard filter named "Region". This dashboard\'s filters: Stage (Prospecting, Won, 1 to 5).', error(unknownName).get('message'));
        ReportsApi.Answer unknownOption = call('run_dashboard', '{"dashboardId":"' + ID + '","filters":[{"name":"Stage","option":"zz-no-such-option"}]}');
        Assert.areEqual('Stage has no option "zz-no-such-option". Its options: Prospecting, Won, 1 to 5.', error(unknownOption).get('message'));
        ReportsApi.Answer twice = call('run_dashboard', '{"dashboardId":"' + ID + '","filters":[{"name":"Stage","option":"Won"},{"name":"stage","option":"Prospecting"}]}');
        Assert.areEqual('The filter Stage is given twice. Give one option per filter.', error(twice).get('message'));
        for (String p : m.paths) Assert.isTrue(p.endsWith('/describe'), p);

        use(new Mock().route(BASE + '/describe', 200, NO_FILTERS));
        Assert.areEqual('This dashboard has no filters. Leave out `filters`.', error(call('run_dashboard', '{"dashboardId":"' + ID + '","filters":[{"name":"Stage","option":"Won"}]}')).get('message'));
    }

    @IsTest
    static void refusesBadInputWithoutACallout() {
        Mock m = use(new Mock());
        Assert.areEqual('A dashboard id starts with 01Z.', error(call('describe_dashboard', '{"dashboardId":"00O000000000001AAA"}')).get('message'));
        Assert.areEqual('dashboardId is required.', error(call('run_dashboard', '{}')).get('message'));
        Assert.areEqual(400, call('run_dashboard', '{"dashboardId":"' + ID + '","maxRows":0}').status);
        Assert.areEqual(400, call('run_dashboard', '{"dashboardId":"' + ID + '","filters":"Stage"}').status);
        Assert.areEqual(400, call('run_dashboard', '{"dashboardId":"' + ID + '","filters":[1]}').status);
        Assert.areEqual('Each filter needs a name and an option.', error(call('run_dashboard', '{"dashboardId":"' + ID + '","filters":[{"name":"","option":"Won"}]}')).get('message'));
        Assert.areEqual('option is required.', error(call('run_dashboard', '{"dashboardId":"' + ID + '","filters":[{"name":"Stage"}]}')).get('message'));
        String four = '{"name":"a","option":"b"}';
        Assert.areEqual(400, call('run_dashboard', '{"dashboardId":"' + ID + '","filters":[' + four + ',' + four + ',' + four + ',' + four + ']}').status);
        Assert.areEqual(400, call('list_dashboards', '{"limit":51}').status);
        Assert.areEqual(400, call('list_dashboards', '{"query":5}').status);
        Assert.areEqual(0, m.paths.size());
    }

    @IsTest
    static void answersSalesforceErrorsAsTheLocalServerDoes() {
        use(new Mock());
        ReportsApi.Answer missing = call('describe_dashboard', '{"dashboardId":"01Z000000000099AAA"}');
        Assert.areEqual(400, missing.status);
        Assert.areEqual('NOT_FOUND', error(missing).get('code'));
        Assert.areEqual(ReportsException.ID_HINT, error(missing).get('hint'));
        // The hosted route without the callout package makes no request.
        ReportsCallout.credentialInstalled = false;
        ReportsApi.Answer hosted = ReportsApi.handle('run_dashboard', '{"dashboardId":"' + ID + '"}', true);
        Assert.areEqual(500, hosted.status);
        Assert.areEqual('CALLOUT_SESSION', error(hosted).get('code'));
    }

    static List<Dashboard> rows(Integer count) {
        List<Object> raw = new List<Object>();
        for (Integer i = 1; i <= count; i++) {
            raw.add(new Map<String, Object>{
                'attributes' => new Map<String, Object>{ 'type' => 'Dashboard' },
                'Id' => '01Z00000000001' + i,
                'Title' => 'Dashboard ' + i,
                'DeveloperName' => 'Dashboard_' + i,
                'FolderName' => 'Dashboards 1',
                'FolderId' => '00l000000000016',
                'Description' => null,
                'Type' => 'LoggedInUser',
                'LastModifiedDate' => '2026-10-17T01:32:09.000+0000'
            });
        }
        return (List<Dashboard>) JSON.deserialize(JSON.serialize(raw), List<Dashboard>.class);
    }

    @IsTest
    static void listsWithTheLastRefreshAndACut() {
        List<Dashboard> found = rows(3);
        String first = String.valueOf(found[0].Id);
        String second = String.valueOf(found[1].Id);
        Mock m = use(new Mock().route('/analytics/dashboards/' + first + '/status', 200, STATUS).route('/analytics/dashboards/' + second + '/status', 500, '[{"errorCode":"UNKNOWN_EXCEPTION","message":"x"}]'));
        Map<String, Object> out = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(ReportsDashboards.listRows(found, 2)));
        Assert.areEqual(2, out.get('count'));
        Assert.areEqual(2, m.paths.size(), 'one status call per row kept');
        Map<String, Object> row = at(items(out, 'dashboards'), 0);
        Assert.areEqual(first, row.get('id'));
        Assert.areEqual('Dashboard 1', row.get('title'));
        Assert.areEqual('Dashboard_1', row.get('developerName'));
        Assert.areEqual('Dashboards 1', row.get('folder'));
        Assert.isTrue(((String) row.get('folderId')).startsWith('00l000000000016'));
        Assert.isTrue(row.containsKey('description'));
        Assert.areEqual('LoggedInUser', row.get('runsAs'));
        Assert.areEqual('2026-10-17T03:00:00.000+0000', row.get('lastRefreshed'), 'the newest refresh date');
        Assert.areEqual('2026-10-17T01:32:09.000+0000', row.get('lastModifiedDate'));
        Assert.isTrue(((String) row.get('url')).endsWith('/lightning/r/Dashboard/' + first + '/view'));
        Assert.isNull(at(items(out, 'dashboards'), 1).get('lastRefreshed'), 'a failed status call gives null');
        Assert.areEqual(new List<Object>{
            'Showing the first 2 matches; more dashboards match. Narrow query or folder, or raise limit (up to 50).',
            'lastRefreshed is null for a dashboard with no data yet: run_dashboard will say so, and refresh_dashboard fills it.'
        }, out.get('notes'));
    }

    @IsTest
    static void stopsCallingStatusAfterACalloutError() {
        Mock m = new Mock();
        m.otherStatus = 401;
        m.otherBody = '[{"errorCode":"INVALID_SESSION_ID","message":"Session expired or invalid"}]';
        use(m);
        Map<String, Object> out = ReportsDashboards.listRows(rows(3), 25);
        Assert.areEqual(3, out.get('count'));
        Assert.areEqual(1, m.paths.size(), 'no status call after CALLOUT_SESSION');
        List<String> notes = (List<String>) out.get('notes');
        Assert.areEqual(1, notes.size(), JSON.serialize(notes));
        Assert.isTrue(notes[0].contains('(CALLOUT_SESSION)'), notes[0]);
        for (Object r : (List<Object>) out.get('dashboards')) Assert.isNull(((Map<String, Object>) r).get('lastRefreshed'));
    }

    @IsTest
    static void listsNothingForNoMatch() {
        use(new Mock().route('*/status', 200, NEVER));
        Map<String, Object> out = ok(call('list_dashboards', '{"query":"zz-no-such-dashboard_%\'","folder":"zz"}'));
        Assert.areEqual(0, out.get('count'));
        Assert.areEqual(new List<Object>(), out.get('notes'));
    }

    /** SOQL on Dashboard against the org's own dashboards, with every /status call mocked. */
    @IsTest(SeeAllData='true')
    static void listsTheOrgsDashboards() {
        use(new Mock().route('*/status', 200, NEVER));
        Map<String, Object> out = ok(call('list_dashboards', '{"limit":1}'));
        List<Object> found = items(out, 'dashboards');
        Assert.isTrue(found.size() <= 1);
        if (!found.isEmpty()) {
            Map<String, Object> row = at(found, 0);
            Assert.isTrue(((String) row.get('id')).startsWith('01Z'), JSON.serialize(row));
            Assert.isNull(row.get('lastRefreshed'));
            Assert.isTrue(items(out, 'notes').contains('lastRefreshed is null for a dashboard with no data yet: run_dashboard will say so, and refresh_dashboard fills it.'));
        }
    }

    @IsTest
    static void readsWordsLabelsAndDates() {
        Assert.areEqual('Won', ReportsDashboards.optionLabel(new Map<String, Object>{ 'alias' => 'Won', 'value' => 'Closed Won' }));
        Assert.areEqual('5', ReportsDashboards.optionLabel(new Map<String, Object>{ 'value' => 5 }));
        Assert.areEqual('10 or more', ReportsDashboards.optionLabel(new Map<String, Object>{ 'value' => '', 'startValue' => '10' }));
        Assert.areEqual('up to 20', ReportsDashboards.optionLabel(new Map<String, Object>{ 'endValue' => '20' }));
        Assert.areEqual('0IC000000000013AAA', ReportsDashboards.optionLabel(new Map<String, Object>{ 'id' => '0IC000000000013AAA', 'alias' => '' }));

        Assert.areEqual('The viewer: each person sees the data they can see, so these results are the signed-in user\'s.', ReportsDashboards.runningUserWords(new Map<String, Object>{ 'dashboardType' => 'LoggedInUser' }));
        Assert.isTrue(ReportsDashboards.runningUserWords(new Map<String, Object>{ 'dashboardType' => 'MyTeamUser' }).startsWith('The viewer, who as a manager'));
        Assert.areEqual('A set user: the dashboard always runs as this user, so every viewer sees the same data.', ReportsDashboards.runningUserWords(new Map<String, Object>{ 'dashboardType' => 'SpecifiedUser' }));
        Assert.areEqual('User 1 (Other)', ReportsDashboards.runningUserWords(new Map<String, Object>{ 'dashboardType' => 'Other', 'runningUser' => new Map<String, Object>{ 'displayName' => 'User 1' } }));
        Assert.areEqual('User 1 (unknown type)', ReportsDashboards.runningUserWords(new Map<String, Object>{ 'runningUser' => new Map<String, Object>{ 'displayName' => 'User 1' } }));
        Assert.areEqual('Unknown', ReportsDashboards.runningUserWords(new Map<String, Object>()));

        Long utc = Datetime.newInstanceGmt(2026, 10, 17, 2, 13, 35).getTime();
        Assert.areEqual(utc, ReportsDashboards.timeOf('2026-10-17T02:13:35.000+0000'));
        Assert.areEqual(utc, ReportsDashboards.timeOf('2026-10-17T02:13:35Z'));
        Assert.areEqual(utc + 5, ReportsDashboards.timeOf('2026-10-17T02:13:35.005Z'));
        Assert.areEqual(utc, ReportsDashboards.timeOf('2026-10-17T04:13:35+02:00'));
        Assert.areEqual(utc, ReportsDashboards.timeOf('2026-10-16T21:13:35-0500'));
        Assert.isNull(ReportsDashboards.timeOf('yesterday'));
        Assert.isNull(ReportsDashboards.timeOf(null));

        Assert.isNull(ReportsDashboards.latestRefresh(JSON.deserializeUntyped(NEVER)));
        Assert.isNull(ReportsDashboards.latestRefresh(null));
        Assert.areEqual('2026-10-17T03:00:00.000+0000', ReportsDashboards.latestRefresh(JSON.deserializeUntyped(STATUS)));
    }

    @IsTest
    static void shapesEdgeCases() {
        // A component missing from componentData has no data; one still running without a result failed; a gauge
        // without bounds has no range; a component without a cell keeps describe's order.
        String meta = '{"name":null,"dashboardType":"LoggedInUser","layout":{"components":[{"row":1,"column":0}]},"components":['
            + '{"id":"c1","header":null,"title":null,"properties":{"visualizationType":"Gauge","aggregates":[],"visualizationProperties":{"breakPoints":[{"breaks":[{"lowerBound":null,"upperBound":5,"color":"red"}]}]}}},'
            + '{"id":"c2","properties":{"visualizationType":"Bar"}}]}';
        String raw = '{"attributes":{"dashboardId":"' + ID + '"},"dashboardMetadata":' + meta + ',"componentData":[{"componentId":"c2","status":{"componentDataStatus":"RUNNING"}}]}';
        ReportsDashboards.Resolved none = ReportsDashboards.resolveFilters(new Map<String, Object>(), new List<ReportsDashboards.Choice>());
        Map<String, Object> out = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(
            ReportsDashboards.shape((Map<String, Object>) JSON.deserializeUntyped(raw), 'https://example.my.salesforce.com', 20, none, Datetime.now())
        ));
        Map<String, Object> dashboard = child(out, 'dashboard');
        Assert.areEqual(ID, dashboard.get('id'));
        Assert.areEqual('Dashboard', dashboard.get('name'));
        Assert.areEqual(new List<Object>(), out.get('filters'));
        Assert.isFalse(out.containsKey('colorPalette'));
        List<Object> components = items(out, 'components');
        Map<String, Object> c1 = at(components, 0);
        Assert.areEqual('c1', c1.get('id'));
        Assert.areEqual('no data', c1.get('status'));
        Assert.isNull(c1.get('measure'));
        Assert.isFalse(c1.containsKey('gauge'));
        Assert.isFalse(child(c1, 'sourceReport').containsKey('url'));
        Map<String, Object> c2 = at(components, 1);
        Assert.areEqual('error', c2.get('status'));
        Assert.areEqual(new Map<String, Object>{ 'code' => 'RUNNING', 'message' => 'Salesforce gave no message.' }, c2.get('error'));
        Assert.areEqual(new List<Object>{
            '1 of 2 components have no data (c1). Call refresh_dashboard with the same filters to fill them.',
            'c2 failed in Salesforce: RUNNING: Salesforce gave no message.'
        }, out.get('notes'));
    }

    // ---- refresh_dashboard ----

    static final String LIMIT_403 = '[{"errorCode":"FORBIDDEN","message":"You can\'t refresh this dashboard more than once in a minute."}]';

    /** One /status answer for the three components: all at this refresh date and state. */
    static String statusAt(String stamp, String refreshStatus) {
        String ids = '01a000000000001AAA,01a000000000003AAA,01a000000000006AAA';
        List<String> parts = new List<String>();
        for (String cid : ids.split(',')) {
            parts.add('{"componentId":"' + cid + '","componentDataStatus":"DATA","refreshDate":"' + stamp + '","refreshStatus":"' + refreshStatus + '"}');
        }
        return '{"componentStatus":[' + String.join(parts, ',') + ']}';
    }

    static final String OLD_DATE = '2026-10-17T02:13:35.000+0000';
    static final String NEW_DATE = '2026-10-17T05:00:00.000+0000';
    static final String BEFORE = statusAt(OLD_DATE, 'IDLE');
    static final String RUNNING = statusAt(OLD_DATE, 'RUNNING');
    static final String DONE = statusAt(NEW_DATE, 'IDLE');

    /** The running user, with the Salesforce_Reports_Write permission set assigned when missing. Call before Test.startTest. */
    static User writer() {
        PermissionSet write = [SELECT Id FROM PermissionSet WHERE Name = :ReportsService.WRITE_PERMISSION_SET];
        List<PermissionSetAssignment> has = [SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = :UserInfo.getUserId() AND PermissionSetId = :write.Id];
        if (has.isEmpty()) insert new PermissionSetAssignment(AssigneeId = UserInfo.getUserId(), PermissionSetId = write.Id);
        return new User(Id = UserInfo.getUserId());
    }

    /** A user without the write permission: a Chatter Free profile, else a Platform one, so it takes no Salesforce license. */
    static User reader() {
        Id profileId = UserInfo.getProfileId();
        for (String key : new List<String>{ 'AUL', 'CSN_User' }) {
            List<Profile> found = [SELECT Id FROM Profile WHERE UserLicense.LicenseDefinitionKey = :key ORDER BY Name LIMIT 1];
            if (!found.isEmpty()) profileId = found[0].Id;
        }
        String name = 'reports-dash-reader-' + UserInfo.getOrganizationId() + '@example.com';
        User u = new User(
            LastName = 'Reader', Alias = 'dreader', Email = name, Username = name, ProfileId = profileId,
            TimeZoneSidKey = 'America/Los_Angeles', LocaleSidKey = 'en_US', EmailEncodingKey = 'UTF-8', LanguageLocaleKey = 'en_US'
        );
        insert u;
        return u;
    }

    /** A mock that answers the PUT, the results GET and a status sequence. */
    static Mock refreshMock(List<String> sequence) {
        Mock m = new Mock().route('PUT ' + BASE, 200, '{}').route(BASE, 200, RESULTS);
        m.statusSequence = sequence;
        return use(m);
    }

    static List<Object> refreshNotes(Map<String, Object> out) {
        return items(out, 'notes');
    }

    static Boolean mentions(List<Object> notes, String text) {
        for (Object n : notes) if (((String) n).contains(text)) return true;
        return false;
    }

    @IsTest
    static void refreshIsDoneOnTheFirstPoll() {
        System.runAs(writer()) {
            Test.startTest();
            Mock m = refreshMock(new List<String>{ BEFORE, DONE });
            Map<String, Object> out = ok(call('refresh_dashboard', '{"dashboardId":"' + ID + '"}'));
            Test.stopTest();
            Assert.areEqual(new List<String>{ BASE + '/status', BASE, BASE + '/status', BASE }, m.paths);
            Assert.areEqual(new List<String>{ 'GET', 'PUT', 'GET', 'GET' }, m.methods);
            Assert.isFalse(mentions(refreshNotes(out), 'refresh had not finished'), JSON.serialize(out.get('notes')));
            Assert.isFalse(mentions(refreshNotes(out), 'once a minute'));
            Assert.areEqual(4, items(out, 'components').size(), 'the run_dashboard result after the refresh');
            Assert.areEqual('Pipeline Overview', child(out, 'dashboard').get('name'));
        }
    }

    @IsTest
    static void refreshIsDoneAfterSeveralPolls() {
        System.runAs(writer()) {
            Test.startTest();
            Mock m = refreshMock(new List<String>{ BEFORE, RUNNING, RUNNING, RUNNING, DONE });
            Map<String, Object> out = ok(call('refresh_dashboard', '{"dashboardId":"' + ID + '"}'));
            Test.stopTest();
            Assert.areEqual(5, m.statusCalls, 'one status before, four polls');
            Assert.areEqual(7, m.paths.size(), 'status, PUT, four polls, results');
            Assert.isFalse(mentions(refreshNotes(out), 'refresh had not finished'));
        }
    }

    @IsTest
    static void refreshStopsAtTheLastPollAndSaysSo() {
        System.runAs(writer()) {
            Test.startTest();
            Mock m = refreshMock(new List<String>{ BEFORE, RUNNING });
            Map<String, Object> out = ok(call('refresh_dashboard', '{"dashboardId":"' + ID + '"}'));
            Test.stopTest();
            Assert.areEqual(1 + ReportsDashboards.REFRESH_POLLS, m.statusCalls, 'one status before, then the poll budget');
            String first = (String) refreshNotes(out)[0];
            Assert.isTrue(first.startsWith('The refresh had not finished when the in-org door stopped waiting (20 status checks)'), first);
            Assert.isTrue(first.contains('Call run_dashboard in a minute'), first);
            Assert.areEqual(4, items(out, 'components').size(), 'the cached results still come back');
        }
    }

    @IsTest
    static void refreshStopsWhenTheTimeBudgetIsSpent() {
        System.runAs(writer()) {
            Test.startTest();
            ReportsDashboards.refreshBudgetMs = 0;
            Mock m = refreshMock(new List<String>{ BEFORE, DONE });
            Map<String, Object> out = ok(call('refresh_dashboard', '{"dashboardId":"' + ID + '"}'));
            Test.stopTest();
            Assert.areEqual(1, m.statusCalls, 'no poll fits in a spent budget');
            Assert.isTrue(((String) refreshNotes(out)[0]).startsWith('The refresh had not finished'));
        }
    }

    @IsTest
    static void aFailedPollCountsAndIsRetried() {
        System.runAs(writer()) {
            Test.startTest();
            Mock m = refreshMock(new List<String>{ BEFORE, 'E:[{"errorCode":"SERVER_ERROR","message":"boom"}]', 'E:<html>', DONE });
            Map<String, Object> out = ok(call('refresh_dashboard', '{"dashboardId":"' + ID + '"}'));
            Test.stopTest();
            Assert.areEqual(4, m.statusCalls);
            Assert.isFalse(mentions(refreshNotes(out), 'refresh had not finished'));
        }
    }

    @IsTest
    static void theOnceAMinuteRefusalIsANoteWithTheCachedResults() {
        System.runAs(writer()) {
            Test.startTest();
            ReportsDashboards.clock = Datetime.newInstanceGmt(2026, 10, 17, 2, 14, 0);
            Mock m = refreshMock(new List<String>{ BEFORE });
            m.route('PUT ' + BASE, 403, LIMIT_403);
            Map<String, Object> out = ok(call('refresh_dashboard', '{"dashboardId":"' + ID + '"}'));
            Test.stopTest();
            Assert.areEqual(1, m.statusCalls, 'no polls after the refusal');
            Assert.areEqual('Salesforce refreshes a dashboard at most once a minute, and this one was refreshed less than a minute ago, so these are the cached results. Try again after 2026-10-17T02:14:35Z.', refreshNotes(out)[0]);
            Assert.areEqual(4, items(out, 'components').size());
        }
    }

    @IsTest
    static void theRefusalNamesAMinuteFromNowWhenTheLastRefreshIsOld() {
        System.runAs(writer()) {
            Test.startTest();
            ReportsDashboards.clock = Datetime.newInstanceGmt(2026, 10, 18, 9, 0, 0);
            Mock m = refreshMock(new List<String>{ BEFORE });
            // Detected by the word "minute" when the code is another.
            m.route('PUT ' + BASE, 403, '[{"errorCode":"INSUFFICIENT_ACCESS","message":"Only one refresh a MINUTE."}]');
            Map<String, Object> out = ok(call('refresh_dashboard', '{"dashboardId":"' + ID + '"}'));
            Test.stopTest();
            Assert.isTrue(((String) refreshNotes(out)[0]).endsWith('Try again after 2026-10-18T09:01:00Z.'), (String) refreshNotes(out)[0]);
        }
    }

    @IsTest
    static void anyOtherRefreshFailureIsThrown() {
        System.runAs(writer()) {
            Test.startTest();
            Mock m = refreshMock(new List<String>{ BEFORE });
            m.route('PUT ' + BASE, 403, '[{"errorCode":"INSUFFICIENT_ACCESS","message":"You cannot refresh this dashboard."}]');
            ReportsApi.Answer a = call('refresh_dashboard', '{"dashboardId":"' + ID + '"}');
            Assert.isTrue(a.status != 200);
            Assert.areEqual('INSUFFICIENT_ACCESS', error(a).get('code'));
            m.route('PUT ' + BASE, 500, '[{"errorCode":"UNKNOWN_EXCEPTION","message":"boom"}]');
            ReportsApi.Answer b = call('refresh_dashboard', '{"dashboardId":"' + ID + '"}');
            Assert.areEqual(500, b.status);
            Assert.areEqual('UNKNOWN_EXCEPTION', error(b).get('code'));
            Test.stopTest();
        }
    }

    @IsTest
    static void aFilterGoesOnTheQueryStringAndNotInTheBody() {
        System.runAs(writer()) {
            Test.startTest();
            Mock m = refreshMock(new List<String>{ BEFORE, DONE });
            m.route(BASE + '/describe', 200, META).route(BASE + '?filter1=0IC000000000013AAA', 200, RESULTS);
            ok(call('refresh_dashboard', '{"dashboardId":"' + ID + '","filters":[{"name":"Stage","option":"Prospecting"}]}'));
            Test.stopTest();
            Assert.areEqual(new List<String>{
                BASE + '/describe', BASE + '/status?filter1=0IC000000000013AAA', BASE + '?filter1=0IC000000000013AAA',
                BASE + '/status?filter1=0IC000000000013AAA', BASE + '?filter1=0IC000000000013AAA'
            }, m.paths);
            Assert.areEqual('PUT', m.methods[2]);
            Assert.isTrue(String.isBlank(m.sentBodies[2]), 'the PUT carries no body');
        }
    }

    @IsTest
    static void withoutThePermissionARefreshIsRefusedBeforeAnyCallout() {
        System.runAs(reader()) {
            Test.startTest();
            Mock m = refreshMock(new List<String>{ BEFORE, DONE });
            ReportsApi.Answer a = call('refresh_dashboard', '{"dashboardId":"' + ID + '"}');
            Assert.areEqual(403, a.status);
            Assert.areEqual('WRITE_NOT_ALLOWED', error(a).get('code'));
            Assert.isTrue(((String) error(a).get('hint')).contains('Salesforce_Reports_Write'));
            Assert.areEqual(0, m.paths.size(), 'refused before any callout');
            // The read tool never checks the permission.
            Assert.areEqual(200, call('run_dashboard', '{"dashboardId":"' + ID + '"}').status);
            Test.stopTest();
        }
    }

    @IsTest
    static void refreshDoneReadsEachComponent() {
        Map<String, String> before = new Map<String, String>{ 'a' => OLD_DATE, 'b' => OLD_DATE };
        Assert.isTrue(ReportsDashboards.refreshDone(new Map<String, Object>(), before), 'no components: done');
        Assert.isFalse(ReportsDashboards.refreshDone((Map<String, Object>) JSON.deserializeUntyped(
            '{"componentStatus":[{"componentId":"a","componentDataStatus":"DATA","refreshDate":"' + NEW_DATE + '"},{"componentId":"b","refreshStatus":"RUNNING"}]}'), before));
        Assert.isFalse(ReportsDashboards.refreshDone((Map<String, Object>) JSON.deserializeUntyped(
            '{"componentStatus":[{"componentId":"a","componentDataStatus":"DATA","refreshDate":"' + OLD_DATE + '"}]}'), before), 'same date as before: not yet');
        Assert.isFalse(ReportsDashboards.refreshDone((Map<String, Object>) JSON.deserializeUntyped(
            '{"componentStatus":[{"componentId":"a","componentDataStatus":"NO_DATA","refreshDate":null}]}'), before));
        Assert.isTrue(ReportsDashboards.refreshDone((Map<String, Object>) JSON.deserializeUntyped(
            '{"componentStatus":[{"componentId":"a","componentDataStatus":"ERROR"},{"componentId":"b","errorCode":"FAILED","componentDataStatus":"NO_DATA"}]}'), before), 'errors count as done');
        Assert.isTrue(ReportsDashboards.refreshDone((Map<String, Object>) JSON.deserializeUntyped(
            '{"componentStatus":[{"componentId":"new","componentDataStatus":"DATA","refreshDate":"' + OLD_DATE + '"}]}'), before), 'a component with no earlier date counts any data as new');
    }

    @IsTest
    static void onlyTheRefreshPutReadsTheLimitCode() {
        Assert.areEqual(ReportsCallout.REFRESH_LIMIT, ReportsCallout.toError(403, LIMIT_403, 'PUT /analytics/dashboards/' + ID).code);
        Assert.areEqual('FORBIDDEN', ReportsCallout.toError(403, LIMIT_403, 'GET /analytics/dashboards/' + ID).code, 'a read keeps its own code');
        Assert.areEqual('NOT_FOUND', ReportsCallout.toError(404, NOT_FOUND, 'PUT /analytics/dashboards/' + ID).code);
    }
}
