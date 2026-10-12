/**
 * The save tools (create_report, update_report, clone_report) against HttpCalloutMock answers shaped like the REST
 * API's. The writer is the running user with the Salesforce_Reports_Write permission set (assigned in the test
 * setup when missing). The reader is a Chatter Free user the test setup creates, so it takes no Salesforce license.
 * Both are rolled back with the test. No report is created. Each test calls inside System.runAs and Test.startTest:
 * without startTest, a callout after runAs fails with "uncommitted work pending".
 */
@IsTest
private class ReportsSaveTest {
    // Ids with a valid 18-character suffix, as the door checks them.
    static final String SAVED_ID = String.valueOf(Id.valueOf('00O000000000001'));
    static final String SOURCE_ID = String.valueOf(Id.valueOf('00O000000000002'));
    static final String FOLDER_ID = '00l000000000001AAA';
    static final String OWNER_ID = '005000000000001AAA';

    static final String EXTENDED = '"reportExtendedMetadata":{'
        + '"detailColumnInfo":{"OPPORTUNITY_NAME":{"label":"Opportunity Name","dataType":"string"},"AMOUNT":{"label":"Amount","dataType":"currency"},"PROBABILITY":{"label":"Probability (%)","dataType":"percent"}},'
        + '"groupingColumnInfo":{"STAGE_NAME":{"label":"Stage","dataType":"picklist"}},'
        + '"aggregateColumnInfo":{"s!AMOUNT":{"label":"Sum of Amount","dataType":"currency"},"RowCount":{"label":"Record Count","dataType":"int"}}}';

    /** What POST /analytics/reports answers for a new summary report in Private Reports. */
    static final String SAVED = '{"attributes":{"reportId":"' + SAVED_ID + '"},'
        + '"reportMetadata":{"id":"' + SAVED_ID + '","name":"zz new","developerName":"zz_new","description":null,"folderId":"' + OWNER_ID + '",'
        + '"reportFormat":"SUMMARY","reportType":{"type":"Opportunity","label":"Opportunities"},"detailColumns":["OPPORTUNITY_NAME","AMOUNT"],'
        + '"groupingsDown":[{"name":"STAGE_NAME","sortOrder":"Asc","dateGranularity":"None"}],"groupingsAcross":[],"aggregates":["s!AMOUNT","RowCount"],'
        + '"reportFilters":[{"column":"AMOUNT","operator":"greaterThan","value":"1000"}],"reportBooleanFilter":null,'
        + '"standardDateFilter":{"column":"CLOSE_DATE","durationValue":"THIS_YEAR","startDate":null,"endDate":null},"scope":"organization","standardFilters":[]},'
        + EXTENDED + ',"reportTypeMetadata":{"categories":[]}}';

    /** The describe of a saved tabular report, with fields Apex does not expose (sortBy, presentationOptions). */
    static final String SOURCE = '{"reportMetadata":{"id":"' + SOURCE_ID + '","name":"Source","developerName":"Source_abc","folderId":"' + FOLDER_ID + '",'
        + '"reportFormat":"TABULAR","reportType":{"type":"Opportunity","label":"Opportunities"},"detailColumns":["OPPORTUNITY_NAME","STAGE_NAME","AMOUNT"],'
        + '"groupingsDown":[],"groupingsAcross":[],"aggregates":["RowCount"],"reportFilters":[{"column":"AMOUNT","operator":"greaterThan","value":"0"}],'
        + '"sortBy":[{"sortColumn":"AMOUNT","sortOrder":"Desc"}],"presentationOptions":{"hasStackedSummaries":true}},' + EXTENDED + '}';

    static final String BEFORE_UPDATE = '{"reportMetadata":{"id":"' + SAVED_ID + '","name":"zz Report","description":"d","folderId":"' + FOLDER_ID + '",'
        + '"reportFormat":"SUMMARY","reportType":{"type":"Opportunity"},"detailColumns":["OPPORTUNITY_NAME","AMOUNT"],'
        + '"groupingsDown":[{"name":"STAGE_NAME","sortOrder":"Asc","dateGranularity":"None"}],"groupingsAcross":[],"aggregates":["RowCount"],'
        + '"reportFilters":[{"column":"AMOUNT","operator":"greaterThan","value":"0"}]}}';

    static final String AFTER_UPDATE = '{"reportMetadata":{"id":"' + SAVED_ID + '","name":"ZZ REPORT","description":"","folderId":"' + FOLDER_ID + '",'
        + '"reportFormat":"SUMMARY","reportType":{"type":"Opportunity"},"detailColumns":["OPPORTUNITY_NAME","AMOUNT","PROBABILITY"],'
        + '"groupingsDown":[{"name":"STAGE_NAME","sortOrder":"Asc","dateGranularity":"None"}],"groupingsAcross":[],"aggregates":["RowCount","mx!PROBABILITY"],'
        + '"reportFilters":[{"column":"AMOUNT","operator":"greaterThan","value":"100000"}]},' + EXTENDED + '}';

    static final String TYPE_DESCRIBE = '{"reportMetadata":{"reportType":{"type":"Opportunity"},"detailColumns":["STAGE_NAME","OPPORTUNITY_NAME","AMOUNT"]}}';

    static final String TYPES = '[{"label":"Opportunities","reportTypes":[{"type":"Opportunity","label":"Opportunities","description":null}]}]';

    static String readerName() {
        return 'reports-mcp-reader-' + UserInfo.getOrganizationId() + '@example.com';
    }

    @TestSetup
    static void users() {
        PermissionSet write = [SELECT Id FROM PermissionSet WHERE Name = :ReportsService.WRITE_PERMISSION_SET];
        List<PermissionSetAssignment> has = [SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = :UserInfo.getUserId() AND PermissionSetId = :write.Id];
        if (has.isEmpty()) insert new PermissionSetAssignment(AssigneeId = UserInfo.getUserId(), PermissionSetId = write.Id);
        // A Chatter Free profile, else a Platform one, so the reader takes no Salesforce license.
        Id profileId = UserInfo.getProfileId();
        for (String key : new List<String>{ 'AUL', 'CSN_User' }) {
            List<Profile> found = [SELECT Id FROM Profile WHERE UserLicense.LicenseDefinitionKey = :key ORDER BY Name LIMIT 1];
            if (!found.isEmpty()) profileId = found[0].Id;
        }
        insert new User(
            LastName = 'Reader', Alias = 'reader', Email = readerName(), Username = readerName(), ProfileId = profileId,
            TimeZoneSidKey = 'America/Los_Angeles', LocaleSidKey = 'en_US', EmailEncodingKey = 'UTF-8', LanguageLocaleKey = 'en_US'
        );
    }

    /** The running user. Inside runAs, the permission set from the test setup counts. */
    static User writer() {
        return new User(Id = UserInfo.getUserId());
    }

    static User reader() {
        return [SELECT Id FROM User WHERE Username = :readerName()];
    }

    static ReportsCalloutTest.Mock use(ReportsCalloutTest.Mock m) {
        Test.setMock(HttpCalloutMock.class, m);
        return m;
    }

    /** Called inside System.runAs and Test.startTest, so the callouts see no uncommitted work from runAs. */
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

    static Map<String, Object> sentMetadata(HttpRequest req) {
        return (Map<String, Object>) ((Map<String, Object>) JSON.deserializeUntyped(req.getBody())).get('reportMetadata');
    }

    @IsTest
    static void createsFromADefinition() {
        System.runAs(writer()) {
            Test.startTest();
            ReportsCalloutTest.Mock m = use(new ReportsCalloutTest.Mock()
                .route('/analytics/reportTypes/Opportunity', 200, TYPE_DESCRIBE)
                .route('/analytics/reports', 200, SAVED));
            Map<String, Object> out = ok(call('create_report',
                '{"name":"zz new","reportType":"Opportunity","groupingsDown":[{"column":"STAGE_NAME"}],"filters":[{"column":"AMOUNT","operator":"greaterThan","value":1000}]}'));
            Assert.areEqual(2, m.requests.size());
            Assert.areEqual('GET', m.requests[0].getMethod());
            HttpRequest post = m.requests[1];
            Assert.areEqual('POST', post.getMethod());
            Assert.isTrue(post.getEndpoint().endsWith('/services/data/v62.0/analytics/reports'), post.getEndpoint());
            Map<String, Object> sent = sentMetadata(post);
            Assert.areEqual('zz new', sent.get('name'));
            Assert.isFalse(sent.containsKey('folderId'), 'no folderId: Private Reports');
            Assert.isFalse(sent.containsKey('description'));
            Assert.areEqual('SUMMARY', sent.get('reportFormat'));
            Assert.areEqual(new List<Object>{ 'OPPORTUNITY_NAME' }, sent.get('detailColumns'));
            Assert.areEqual(SAVED_ID, out.get('id'));
            Assert.areEqual('zz new', out.get('name'));
            Assert.areEqual(OWNER_ID, out.get('folderId'));
            Assert.isTrue(((String) out.get('url')).endsWith('/lightning/r/Report/' + SAVED_ID + '/view'));
            Assert.isFalse(out.containsKey('folder'), 'the mocked report is not in the org');
            Map<String, Object> summary = (Map<String, Object>) out.get('summary');
            Assert.areEqual('SUMMARY', summary.get('format'));
            Assert.areEqual('zz_new', summary.get('developerName'));
            Assert.areEqual('Stage', ((Map<String, Object>) ((List<Object>) summary.get('groupingsDown'))[0]).get('label'));
            Assert.isTrue(((List<Object>) summary.get('filters')).contains('Amount greater than 1000'), JSON.serialize(summary.get('filters')));
            Assert.isTrue(String.join((List<Object>) out.get('notes'), ' ').contains('OPPORTUNITY_NAME was added'), JSON.serialize(out.get('notes')));
            Test.stopTest();
        }
    }

    @IsTest
    static void createsFromASavedReport() {
        System.runAs(writer()) {
            Test.startTest();
            ReportsCalloutTest.Mock m = use(new ReportsCalloutTest.Mock()
                .route('/analytics/reports/' + SOURCE_ID + '/describe', 200, SOURCE)
                .route('/analytics/reports', 200, SAVED));
            Map<String, Object> out = ok(call('create_report', '{"name":"zz copy","description":"Copied","folderId":"' + FOLDER_ID + '","fromReportId":"' + SOURCE_ID + '",'
                + '"groupingsDown":[{"column":"STAGE_NAME"}],"aggregates":["RowCount",{"fn":"sum","column":"PROBABILITY"}]}'));
            Assert.areEqual(2, m.requests.size(), 'the copy has detail columns, so no report type describe');
            Assert.isTrue(m.requests[0].getEndpoint().endsWith('/analytics/reports/' + SOURCE_ID + '/describe'));
            Map<String, Object> sent = sentMetadata(m.requests[1]);
            Assert.isFalse(sent.containsKey('id'));
            Assert.isFalse(sent.containsKey('developerName'));
            Assert.areEqual('zz copy', sent.get('name'));
            Assert.areEqual('Copied', sent.get('description'));
            Assert.areEqual(FOLDER_ID, sent.get('folderId'));
            Assert.areEqual('SUMMARY', sent.get('reportFormat'));
            Assert.areEqual(new List<Object>{ 'OPPORTUNITY_NAME', 'AMOUNT', 'PROBABILITY' }, sent.get('detailColumns'));
            Assert.areEqual(new List<Object>{ 'RowCount', 's!PROBABILITY' }, sent.get('aggregates'));
            Assert.isNotNull(sent.get('sortBy'), 'fields Apex does not expose are kept');
            Assert.isNotNull(sent.get('presentationOptions'));
            Assert.areEqual(1, ((List<Object>) sent.get('reportFilters')).size(), 'filters not sent stay as saved');
            Assert.areEqual(SAVED_ID, out.get('id'));
            Assert.isNotNull(out.get('summary'));
            Test.stopTest();
        }
    }

    @IsTest
    static void appliesChangesAsTheLocalServerDoes() {
        Map<String, Object> before = (Map<String, Object>) ((Map<String, Object>) JSON.deserializeUntyped(SOURCE)).get('reportMetadata');
        Map<String, Object> matrix = ReportsService.applyChanges(before, new Map<String, Object>(), new Map<String, Object>{
            'groupingsDown' => new List<Object>{ new Map<String, Object>{ 'name' => 'STAGE_NAME' } },
            'groupingsAcross' => new List<Object>{ new Map<String, Object>{ 'name' => 'TYPE' } }
        });
        Assert.areEqual('MATRIX', matrix.get('reportFormat'));
        Assert.areEqual(new List<Object>{ 'OPPORTUNITY_NAME', 'AMOUNT' }, matrix.get('detailColumns'));
        Assert.isFalse(matrix.containsKey('folderId'));
        Map<String, Object> flat = ReportsService.applyChanges(before, new Map<String, Object>(), new Map<String, Object>());
        Assert.areEqual('TABULAR', flat.get('reportFormat'));
        Assert.areEqual(new List<Object>{ 'OPPORTUNITY_NAME', 'STAGE_NAME', 'AMOUNT' }, flat.get('detailColumns'));
        Map<String, Object> given = ReportsService.applyChanges(before, new Map<String, Object>{ 'format' => 'SUMMARY' }, new Map<String, Object>{ 'reportFormat' => 'SUMMARY' });
        Assert.areEqual('SUMMARY', given.get('reportFormat'));
        Map<String, Object> groupedAggregate = ReportsService.applyChanges(before,
            new Map<String, Object>{ 'aggregates' => new List<Object>{ new Map<String, Object>{ 'fn' => 'max', 'column' => 'STAGE_NAME' }, 's!AMOUNT' } },
            new Map<String, Object>{ 'groupingsDown' => new List<Object>{ new Map<String, Object>{ 'name' => 'STAGE_NAME' } } });
        Assert.areEqual(new List<Object>{ 'OPPORTUNITY_NAME', 'AMOUNT' }, groupedAggregate.get('detailColumns'), 'a grouped column is never a detail column');
    }

    @IsTest
    static void refusesABadCreateBeforeAnyCallout() {
        System.runAs(writer()) {
            Test.startTest();
            ReportsCalloutTest.Mock m = use(new ReportsCalloutTest.Mock());
            ReportsApi.Answer noType = call('create_report', '{"name":"zz"}');
            Assert.areEqual(400, noType.status);
            Assert.isTrue(((String) error(noType).get('message')).contains('reportType'));
            Assert.areEqual(400, call('create_report', '{"reportType":"Opportunity"}').status);
            Assert.areEqual(400, call('create_report', '{"name":"","reportType":"Opportunity"}').status);
            Assert.areEqual(400, call('create_report', '{"name":"' + 'x'.repeat(41) + '","reportType":"Opportunity"}').status);
            Assert.areEqual(400, call('create_report', '{"name":"zz","fromReportId":"abc"}').status);
            Assert.areEqual(400, call('create_report', 'not json').status);
            Assert.areEqual(0, m.requests.size());
            Test.stopTest();
        }
    }

    @IsTest
    static void updatesAReport() {
        System.runAs(writer()) {
            Test.startTest();
            ReportsCalloutTest.Mock m = use(new ReportsCalloutTest.Mock()
                .route('/analytics/reports/' + SAVED_ID + '/describe', 200, BEFORE_UPDATE)
                .route('/analytics/reports/' + SAVED_ID, 200, AFTER_UPDATE));
            Map<String, Object> out = ok(call('update_report', '{"reportId":"' + SAVED_ID + '","name":"ZZ REPORT","description":"","folderId":"' + FOLDER_ID + '",'
                + '"filters":[{"column":"AMOUNT","operator":"greaterThan","value":100000}],"aggregates":["RowCount",{"fn":"max","column":"PROBABILITY"}]}'));
            Assert.areEqual(2, m.requests.size());
            HttpRequest patch = m.requests[1];
            Assert.areEqual('PATCH', patch.getMethod());
            Assert.isTrue(patch.getEndpoint().endsWith('/analytics/reports/' + SAVED_ID), patch.getEndpoint());
            Map<String, Object> sent = sentMetadata(patch);
            Assert.areEqual(new List<Object>{ 'OPPORTUNITY_NAME', 'AMOUNT', 'PROBABILITY' }, sent.get('detailColumns'), 'the saved columns plus the aggregated one');
            Assert.isFalse(sent.containsKey('groupingsDown'), 'only the given fields are sent');
            List<Object> changes = (List<Object>) out.get('changes');
            Assert.areEqual(new List<Object>{
                'aggregates: ["RowCount"] -> ["RowCount","mx!PROBABILITY"]',
                'reportFilters: [{"column":"AMOUNT","operator":"greaterThan","value":"0"}] -> [{"column":"AMOUNT","operator":"greaterThan","value":"100000"}]',
                'name: "zz Report" -> "ZZ REPORT"',
                'description: "d" -> ""',
                'folderId: unchanged',
                'detailColumns: ["OPPORTUNITY_NAME","AMOUNT"] -> ["OPPORTUNITY_NAME","AMOUNT","PROBABILITY"]'
            }, changes);
            Map<String, Object> summary = (Map<String, Object>) out.get('summary');
            Assert.areEqual('ZZ REPORT', summary.get('name'));
            Assert.areEqual(3, ((List<Object>) summary.get('columns')).size());
            Assert.areEqual(new List<Object>(), out.get('notes'));
            Test.stopTest();
        }
    }

    @IsTest
    static void updatesWithColumnsGivenAndClipsLongChanges() {
        System.runAs(writer()) {
            Test.startTest();
            ReportsCalloutTest.Mock m = use(new ReportsCalloutTest.Mock()
                .route('/analytics/reports/' + SAVED_ID + '/describe', 200, BEFORE_UPDATE)
                .route('/analytics/reports/' + SAVED_ID, 200, AFTER_UPDATE));
            Map<String, Object> out = ok(call('update_report', '{"reportId":"' + SAVED_ID + '","columns":["OPPORTUNITY_NAME","AMOUNT","PROBABILITY"],"aggregates":["RowCount"]}'));
            Assert.isFalse(sentMetadata(m.requests[1]).containsKey('name'));
            List<Object> changes = (List<Object>) out.get('changes');
            Assert.areEqual('detailColumns: ["OPPORTUNITY_NAME","AMOUNT"] -> ["OPPORTUNITY_NAME","AMOUNT","PROBABILITY"]', changes[0]);
            Assert.areEqual('(none)', ReportsService.clip(null));
            String clipped = ReportsService.clip('x'.repeat(200));
            Assert.areEqual(160, clipped.length());
            Assert.isTrue(clipped.endsWith('...'));
            Assert.areEqual('short', ReportsService.clip('short'));
        Assert.areEqual('{"a":[1,null,true],"b":{"c":"x","d":1.5}}', ReportsService.sortedJson(JSON.deserializeUntyped('{"b":{"d":1.5,"c":"x"},"a":[1,null,true]}')));
            Test.stopTest();
        }
    }

    @IsTest
    static void refusesAnUpdateWithNothingToChange() {
        System.runAs(writer()) {
            Test.startTest();
            ReportsCalloutTest.Mock m = use(new ReportsCalloutTest.Mock());
            ReportsApi.Answer a = call('update_report', '{"reportId":"' + SAVED_ID + '"}');
            Assert.areEqual(400, a.status);
            Assert.areEqual('Nothing to update. Give at least one field to change.', error(a).get('message'));
            Assert.areEqual(400, call('update_report', '{"reportId":"' + SAVED_ID + '","name":"' + 'x'.repeat(41) + '"}').status);
            Assert.areEqual(0, m.requests.size());
            Test.stopTest();
        }
    }

    @IsTest
    static void clonesAReport() {
        System.runAs(writer()) {
            Test.startTest();
            ReportsCalloutTest.Mock m = use(new ReportsCalloutTest.Mock().route('/analytics/reports', 200, SAVED));
            Map<String, Object> out = ok(call('clone_report', '{"reportId":"' + SOURCE_ID + '","name":"zz clone","folderId":"' + FOLDER_ID + '"}'));
            HttpRequest post = m.requests[0];
            Assert.areEqual('POST', post.getMethod());
            Assert.isTrue(post.getEndpoint().endsWith('/analytics/reports?cloneId=' + SOURCE_ID), post.getEndpoint());
            Assert.areEqual(new Map<String, Object>{ 'name' => 'zz clone', 'folderId' => FOLDER_ID }, sentMetadata(post));
            Assert.areEqual(new Set<String>{ 'id', 'name', 'folderId', 'url' }, out.keySet());
            Assert.areEqual(SAVED_ID, out.get('id'));
            ok(call('clone_report', '{"reportId":"' + SOURCE_ID + '"}'));
            Assert.areEqual(new Map<String, Object>(), sentMetadata(m.requests[1]), 'no name or folder: Salesforce names it, in Private Reports');
            Test.stopTest();
        }
    }

    @IsTest
    static void refusesASaveWithoutThePermission() {
        System.runAs(reader()) {
            Test.startTest();
            ReportsCalloutTest.Mock m = use(new ReportsCalloutTest.Mock().route('/analytics/reportTypes', 200, TYPES).route('/analytics/reports', 200, SAVED));
            Map<String, String> bodies = new Map<String, String>{
                'create_report' => '{"name":"zz","reportType":"Opportunity"}',
                'update_report' => '{"reportId":"' + SAVED_ID + '","name":"zz"}',
                'clone_report' => '{"reportId":"' + SAVED_ID + '"}'
            };
            for (String tool : bodies.keySet()) {
                ReportsApi.Answer a = call(tool, bodies.get(tool));
                Assert.areEqual(403, a.status, tool);
                Assert.areEqual('WRITE_NOT_ALLOWED', error(a).get('code'), tool);
                Assert.isTrue(((String) error(a).get('hint')).contains('Salesforce_Reports_Write'), tool);
            }
            Assert.areEqual(0, m.requests.size(), 'refused before any callout');
            // The read tools never check the permission.
            Assert.areEqual(200, call('list_report_types', '{}').status);
            Assert.areEqual(1, m.requests.size());
            Test.stopTest();
        }
    }

    @IsTest
    static void passesSalesforceErrorsThrough() {
        System.runAs(writer()) {
            Test.startTest();
            use(new ReportsCalloutTest.Mock()
                .route('/analytics/reports', 400, '[{"errorCode":"BAD_REQUEST","message":"The column NO_SUCH_COLUMN is not valid."}]')
                .route('/analytics/reports/' + SAVED_ID + '/describe', 200, BEFORE_UPDATE)
                .route('/analytics/reports/' + SAVED_ID, 403, '[{"errorCode":"INSUFFICIENT_ACCESS","message":"You cannot save this report."}]'));
            ReportsApi.Answer created = call('create_report', '{"name":"zz","reportType":"Opportunity","columns":["NO_SUCH_COLUMN"]}');
            Assert.areEqual(400, created.status);
            Assert.areEqual('BAD_REQUEST', error(created).get('code'));
            Assert.areEqual('The column NO_SUCH_COLUMN is not valid.', error(created).get('message'));
            Assert.isTrue(((String) error(created).get('hint')).contains('describe_report_type'));
            ReportsApi.Answer updated = call('update_report', '{"reportId":"' + SAVED_ID + '","name":"zz"}');
            Assert.areEqual(400, updated.status);
            Assert.areEqual('INSUFFICIENT_ACCESS', error(updated).get('code'));
            Assert.isTrue(((String) error(updated).get('hint')).contains('Create and Customize Reports'));
            ReportsApi.Answer cloned = call('clone_report', '{"reportId":"' + SOURCE_ID + '"}');
            Assert.areEqual(400, cloned.status, 'the mock answers 400 for POST /analytics/reports');
            ReportsApi.Answer missing = call('create_report', '{"name":"zz","fromReportId":"' + SOURCE_ID + '"}');
            Assert.areEqual(400, missing.status);
            Assert.areEqual('NOT_FOUND', error(missing).get('code'));
            Test.stopTest();
        }
    }

    @IsTest
    static void answersCalloutSessionForARefusedSession() {
        System.runAs(writer()) {
            Test.startTest();
            use(ReportsCalloutTest.refusing());
            ReportsApi.Answer a = call('clone_report', '{"reportId":"' + SOURCE_ID + '"}');
            Assert.areEqual(500, a.status);
            Assert.areEqual('CALLOUT_SESSION', error(a).get('code'));
            Test.stopTest();
        }
    }

    /** On the hosted MCP door's route without the callout-app package, a save answers CALLOUT_SESSION, with no callout. */
    @IsTest
    static void answersCalloutSessionOnTheHostedRoute() {
        ReportsCallout.credentialInstalled = false;
        System.runAs(writer()) {
            Test.startTest();
            ReportsCalloutTest.Mock m = use(new ReportsCalloutTest.Mock().route('/analytics/reportTypes', 200, TYPES).route('/analytics/reports', 200, SAVED));
            Map<String, String> bodies = new Map<String, String>{
                'create_report' => '{"name":"zz","reportType":"Opportunity"}',
                'update_report' => '{"reportId":"' + SAVED_ID + '","name":"zz"}',
                'clone_report' => '{"reportId":"' + SOURCE_ID + '"}'
            };
            for (String tool : bodies.keySet()) {
                ReportsApi.Answer a = ReportsApi.handle(tool, bodies.get(tool), true);
                Assert.areEqual(500, a.status, tool);
                Assert.areEqual('CALLOUT_SESSION', error(a).get('code'), tool);
                Assert.areEqual(ReportsCallout.HOSTED_HINT, error(a).get('hint'), tool);
            }
            Assert.areEqual(0, m.requests.size(), 'no callout on the hosted route');
            Test.stopTest();
        }
    }

    /** On the hosted route with the callout-app package, a save calls out through the named credential, as the user. */
    @IsTest
    static void savesThroughTheNamedCredentialOnTheHostedRoute() {
        ReportsCallout.credentialInstalled = true;
        System.runAs(writer()) {
            Test.startTest();
            ReportsCalloutTest.Mock m = use(new ReportsCalloutTest.Mock().route('/analytics/reports', 200, SAVED));
            ReportsApi.Answer a = ReportsApi.handle('clone_report', '{"reportId":"' + SOURCE_ID + '","name":"zz clone"}', true);
            Assert.areEqual(200, a.status, JSON.serialize(a.body));
            Assert.areEqual('callout:SalesforceReportsCallout/services/data/v62.0/analytics/reports?cloneId=' + SOURCE_ID, m.requests[0].getEndpoint());
            Assert.isNull(m.requests[0].getHeader('Authorization'));
            Test.stopTest();
        }
    }

    /** The write permission is checked before the credential: a reader gets WRITE_NOT_ALLOWED, with no callout. */
    @IsTest
    static void checksTheWritePermissionBeforeTheCredential() {
        ReportsCallout.credentialInstalled = true;
        System.runAs(reader()) {
            Test.startTest();
            ReportsCalloutTest.Mock m = use(new ReportsCalloutTest.Mock().route('/analytics/reports', 200, SAVED));
            ReportsApi.Answer a = ReportsApi.handle('clone_report', '{"reportId":"' + SOURCE_ID + '"}', true);
            Assert.areEqual(403, a.status);
            Assert.areEqual('WRITE_NOT_ALLOWED', error(a).get('code'));
            Assert.areEqual(0, m.requests.size());
            Test.stopTest();
        }
    }
}
