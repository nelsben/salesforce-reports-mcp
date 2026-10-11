@IsTest
private class ReportsSummaryTest {
    static ReportsSummary.InfoMaps maps() {
        ReportsSummary.InfoMaps maps = new ReportsSummary.InfoMaps();
        maps.detail.put('AMOUNT', ReportsSummary.info('Amount', 'currency'));
        maps.grouping.put('STAGE_NAME', ReportsSummary.info('Stage', 'picklist'));
        maps.aggregate.put('s!AMOUNT', ReportsSummary.info('Sum of Amount', 'currency'));
        return maps;
    }

    static Map<String, Object> meta() {
        return (Map<String, Object>) JSON.deserializeUntyped('{'
            + '"id":"00O000000000001AAA","name":"Pipeline","developerName":"Pipeline_x","description":null,"folderId":"005000000000001AAA",'
            + '"reportFormat":"SUMMARY","reportType":{"type":"Opportunity","label":"Opportunities"},'
            + '"standardDateFilter":{"column":"CLOSE_DATE","durationValue":"THIS_YEAR","startDate":"2026-01-01","endDate":"2026-12-31"},'
            + '"reportFilters":[{"column":"AMOUNT","operator":"greaterThan","value":"5"},{"column":"TYPE","operator":"weird","value":null}],'
            + '"reportBooleanFilter":"1 OR 2","scope":"organization","standardFilters":[{"name":"open","value":"all"}],'
            + '"groupingsDown":[{"name":"STAGE_NAME","sortOrder":"Asc","dateGranularity":"None"}],"groupingsAcross":[]'
            + '}');
    }

    @IsTest
    static void humanizesAndLabels() {
        Assert.areEqual('Amount', ReportsSummary.humanize('s!AMOUNT'));
        Assert.areEqual('Close Date', ReportsSummary.humanize('CLOSE_DATE'));
        Assert.areEqual('Amount', ReportsSummary.columnLabel('AMOUNT', maps()));
        Assert.areEqual('Stage', ReportsSummary.columnLabel('STAGE_NAME', maps()));
        Assert.areEqual('Sum of Amount', ReportsSummary.columnLabel('s!AMOUNT', maps()));
        Assert.areEqual('Lead Source', ReportsSummary.columnLabel('LEAD_SOURCE', maps()));
        Assert.areEqual('currency', ReportsSummary.dataType(Reports.ColumnDataType.CURRENCY_DATA));
        Assert.areEqual('datetime', ReportsSummary.dataType(Reports.ColumnDataType.DATETIME_DATA));
        Assert.isNull(ReportsSummary.dataType(null));
        Assert.areEqual('currency', maps().cellType('AMOUNT'));
        Assert.areEqual('picklist', maps().cellType('STAGE_NAME'));
        Assert.isNull(maps().cellType('NOPE'));
        Assert.areEqual('Amount', maps().detailLabel('AMOUNT'));
        Assert.isNull(maps().detailLabel('NOPE'));
    }

    @IsTest
    static void describesFiltersInWords() {
        List<String> lines = ReportsSummary.describeFilters(meta(), maps());
        Assert.areEqual(new List<String>{
            'Close Date: THIS_YEAR',
            '1. Amount greater than 5',
            '2. Type weird',
            'Filter logic: 1 OR 2',
            'Scope: organization',
            'Standard filter open: all'
        }, lines);
        Map<String, Object> custom = new Map<String, Object>{
            'standardDateFilter' => new Map<String, Object>{ 'column' => 'CLOSE_DATE', 'durationValue' => 'CUSTOM', 'startDate' => '2026-01-01' }
        };
        Assert.areEqual(new List<String>{ 'Close Date: 2026-01-01 to ...' }, ReportsSummary.describeFilters(custom, maps()));
    }

    @IsTest
    static void summarizesAReport() {
        Map<String, Object> m = meta();
        m.put('detailColumns', new List<String>{ 'AMOUNT', 'NEXT_STEP' });
        m.put('aggregates', new List<String>{ 's!AMOUNT', 'RowCount' });
        Map<String, Object> s = ReportsSummary.summarizeReport(m, maps(), 'https://x.my.salesforce.com', true);
        Assert.areEqual('https://x.my.salesforce.com/lightning/r/Report/00O000000000001AAA/view', s.get('url'));
        Assert.areEqual('SUMMARY', s.get('format'));
        Assert.areEqual('Opportunity', s.get('reportType'));
        List<Object> columns = (List<Object>) s.get('columns');
        Assert.areEqual('currency', ((Map<String, Object>) columns[0]).get('dataType'));
        Assert.isFalse(((Map<String, Object>) columns[1]).containsKey('dataType'));
        Assert.areEqual('Rowcount', ((Map<String, Object>) ((List<Object>) s.get('aggregates'))[1]).get('label'));
        Assert.areEqual('Stage', ((Map<String, Object>) ((List<Object>) s.get('groupingsDown'))[0]).get('label'));
        Assert.isTrue(s.containsKey('reportMetadata'));
        Assert.isNull(ReportsSummary.reportUrl(null, 'x'));
        Assert.isNull(ReportsSummary.reportUrl('https://x', null));
    }
}
