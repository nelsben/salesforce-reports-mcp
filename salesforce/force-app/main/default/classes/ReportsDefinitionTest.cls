@IsTest
private class ReportsDefinitionTest {
    static Map<String, Object> json(String text) {
        return (Map<String, Object>) JSON.deserializeUntyped(text);
    }

    @IsTest
    static void mapsAFullDefinition() {
        ReportsDefinition.Mapped mapped = ReportsDefinition.toReportMetadata(json('{'
            + '"reportType":"Opportunity",'
            + '"columns":["STAGE_NAME","OPPORTUNITY_NAME"],'
            + '"groupingsDown":[{"column":"STAGE_NAME","sortOrder":"Desc"}],'
            + '"groupingsAcross":[{"column":"CLOSE_DATE","dateGranularity":"FiscalQuarter"}],'
            + '"aggregates":["RowCount",{"fn":"sum","column":"AMOUNT"},{"fn":"max","column":"AMOUNT"}],'
            + '"filters":[{"column":"AMOUNT","operator":"greaterThan","value":1000},{"column":"CLOSED","operator":"equals","value":false},{"column":"PROBABILITY","operator":"equals","value":1.50}],'
            + '"filterLogic":"1 AND (2 OR 3)",'
            + '"dateFilter":{"column":"CLOSE_DATE","startDate":"2026-01-01"},'
            + '"sortBy":[{"column":"AMOUNT","order":"Desc"}],'
            + '"topRows":{"rowLimit":5,"direction":"Asc"},'
            + '"scope":"organization",'
            + '"reportMetadata":{"standardFilters":[{"name":"open","value":"all"}]}'
            + '}'), false);
        Map<String, Object> m = mapped.metadata;
        Assert.areEqual('MATRIX', m.get('reportFormat'));
        Assert.areEqual('Opportunity', ((Map<String, Object>) m.get('reportType')).get('type'));
        Assert.areEqual(new List<String>{ 'OPPORTUNITY_NAME', 'AMOUNT' }, m.get('detailColumns'));
        Assert.areEqual(new List<String>{ 'RowCount', 's!AMOUNT', 'mx!AMOUNT' }, m.get('aggregates'));
        Assert.areEqual(2, mapped.notes.size());
        Assert.isTrue(mapped.notes[0].startsWith('Left out STAGE_NAME'));
        Assert.isTrue(mapped.notes[1].startsWith('Added AMOUNT'));
        Map<String, Object> down = (Map<String, Object>) ((List<Object>) m.get('groupingsDown'))[0];
        Assert.areEqual('Desc', down.get('sortOrder'));
        Assert.areEqual('None', down.get('dateGranularity'));
        List<Object> filters = (List<Object>) m.get('reportFilters');
        Assert.areEqual('1000', ((Map<String, Object>) filters[0]).get('value'));
        Assert.areEqual('false', ((Map<String, Object>) filters[1]).get('value'));
        Assert.areEqual('1.5', ((Map<String, Object>) filters[2]).get('value'));
        Assert.areEqual('1 AND (2 OR 3)', m.get('reportBooleanFilter'));
        Map<String, Object> dateFilter = (Map<String, Object>) m.get('standardDateFilter');
        Assert.areEqual('CUSTOM', dateFilter.get('durationValue'));
        Assert.isFalse(dateFilter.containsKey('endDate'));
        Assert.areEqual('Desc', ((Map<String, Object>) ((List<Object>) m.get('sortBy'))[0]).get('sortOrder'));
        Assert.areEqual(5, ((Map<String, Object>) m.get('topRows')).get('rowLimit'));
        Assert.areEqual('organization', m.get('scope'));
        Assert.isTrue(m.containsKey('standardFilters'));
    }

    @IsTest
    static void infersTheFormatAndDefaults() {
        Map<String, Object> tabular = ReportsDefinition.toReportMetadata(json('{"reportType":"Opportunity"}'), false).metadata;
        Assert.areEqual('TABULAR', tabular.get('reportFormat'));
        Assert.areEqual(new List<String>{ 'RowCount' }, tabular.get('aggregates'));
        Map<String, Object> summary = ReportsDefinition.toReportMetadata(json('{"groupingsDown":[{"column":"STAGE_NAME"}],"aggregates":[{"fn":"avg","column":"AMOUNT"}]}'), false).metadata;
        Assert.areEqual('SUMMARY', summary.get('reportFormat'));
        Assert.areEqual(new List<String>{ 'AMOUNT' }, summary.get('detailColumns'));
        Map<String, Object> dated = ReportsDefinition.toReportMetadata(json('{"dateFilter":{"column":"CLOSE_DATE","duration":"THIS_YEAR"}}'), true).metadata;
        Assert.areEqual('THIS_YEAR', ((Map<String, Object>) dated.get('standardDateFilter')).get('durationValue'));
    }

    @IsTest
    static void partialGivesOnlyTheGivenFields() {
        Assert.isTrue(ReportsDefinition.toReportMetadata(new Map<String, Object>(), true).metadata.isEmpty());
        Map<String, Object> m = ReportsDefinition.toReportMetadata(json('{"aggregates":[{"fn":"min","column":"AMOUNT"},{"fn":"unique","column":"OPPORTUNITY_NAME"}]}'), true).metadata;
        Assert.areEqual(new Set<String>{ 'aggregates' }, m.keySet());
        Assert.areEqual(new List<String>{ 'AMOUNT', 'OPPORTUNITY_NAME' }, ReportsDefinition.aggregateColumns((List<String>) m.get('aggregates')));
        Assert.areEqual(0, ReportsDefinition.aggregateColumns(null).size());
    }

    @IsTest
    static void rejectsBadInput() {
        List<String> bad = new List<String>{
            '{"format":"JOINED"}',
            '{"groupingsDown":[{"column":"A","dateGranularity":"Fortnight"}]}',
            '{"groupingsDown":[{"column":"A"},{"column":"B"},{"column":"C"},{"column":"D"}]}',
            '{"groupingsDown":[{"column":"A","sortOrder":"Up"}]}',
            '{"aggregates":[{"fn":"median","column":"AMOUNT"}]}',
            '{"filters":[{"column":"A","operator":"equals"}]}',
            '{"filters":[{"column":"A","operator":"equals","value":[1]}]}',
            '{"columns":"AMOUNT"}',
            '{"columns":[1]}',
            '{"reportType":7}',
            '{"filters":["x"]}',
            '{"topRows":{"rowLimit":0,"direction":"Asc"}}'
        };
        for (String text : bad) {
            try {
                ReportsDefinition.toReportMetadata(json(text), true);
                Assert.fail('expected an error for ' + text);
            } catch (ReportsException e) {
                Assert.areEqual('INVALID_INPUT', e.code, text);
            }
        }
    }

    @IsTest
    static void appliesOntoReportMetadata() {
        Reports.ReportMetadata m = new Reports.ReportMetadata();
        Map<String, Object> mapped = ReportsDefinition.toReportMetadata(json('{'
            + '"format":"MATRIX","columns":["AMOUNT"],'
            + '"groupingsDown":[{"column":"STAGE_NAME","sortOrder":"Desc"}],'
            + '"groupingsAcross":[{"column":"CLOSE_DATE","dateGranularity":"MonthInYear"}],'
            + '"aggregates":["RowCount"],'
            + '"filters":[{"column":"AMOUNT","operator":"greaterThan","value":"5"}],"filterLogic":"1",'
            + '"dateFilter":{"column":"CLOSE_DATE","duration":"THIS_YEAR"},'
            + '"sortBy":[{"column":"AMOUNT","order":"Asc"}],"topRows":{"rowLimit":3,"direction":"Desc"},"scope":"user",'
            + '"reportMetadata":{"standardFilters":[{"name":"open","value":"all"}]}'
            + '}'), true).metadata;
        ReportsDefinition.applyTo(m, mapped);
        Map<String, Object> back = ReportsSummary.metadataMap(m);
        Assert.areEqual('MATRIX', back.get('reportFormat'));
        Map<String, Object> down = (Map<String, Object>) ((List<Object>) back.get('groupingsDown'))[0];
        Assert.areEqual('Desc', down.get('sortOrder'));
        Map<String, Object> across = (Map<String, Object>) ((List<Object>) back.get('groupingsAcross'))[0];
        Assert.areEqual('MonthInYear', across.get('dateGranularity'));
        Assert.areEqual(new List<String>{ 'AMOUNT' }, back.get('detailColumns'));
        Assert.areEqual('5', ((Map<String, Object>) ((List<Object>) back.get('reportFilters'))[0]).get('value'));
        Assert.areEqual('1', back.get('reportBooleanFilter'));
        Assert.areEqual('THIS_YEAR', ((Map<String, Object>) back.get('standardDateFilter')).get('durationValue'));
        Assert.areEqual('Asc', ((Map<String, Object>) ((List<Object>) back.get('sortBy'))[0]).get('sortOrder'));
        Assert.areEqual('Desc', ((Map<String, Object>) back.get('topRows')).get('direction'));
        Assert.areEqual('user', back.get('scope'));
        Assert.areEqual('all', ((Map<String, Object>) ((List<Object>) back.get('standardFilters'))[0]).get('value'));
    }

    @IsTest
    static void refusesWhatTheDoorCannotApply() {
        List<Map<String, Object>> bad = new List<Map<String, Object>>{
            new Map<String, Object>{ 'reportType' => new Map<String, Object>{ 'type' => 'Account' } },
            new Map<String, Object>{ 'chart' => new Map<String, Object>() },
            new Map<String, Object>{ 'aggregates' => 'RowCount' },
            new Map<String, Object>{ 'reportFormat' => 'PIVOT' },
            new Map<String, Object>{ 'groupingsDown' => new List<Object>{ new Map<String, Object>{ 'name' => 'A', 'dateGranularity' => 'Fortnight' } } }
        };
        for (Map<String, Object> meta : bad) {
            try {
                ReportsDefinition.applyTo(new Reports.ReportMetadata(), meta);
                Assert.fail('expected an error for ' + meta);
            } catch (ReportsException e) {
                Assert.areEqual(ReportsException.ErrorCategory.INVALID_INPUT, e.category);
            }
        }
    }

    @IsTest
    static void namesEnumsAsRestDoes() {
        Assert.areEqual('FiscalQuarter', ReportsDefinition.restGranularity(Reports.DateGranularity.FISCAL_QUARTER));
        Assert.areEqual('None', ReportsDefinition.restGranularity(Reports.DateGranularity.NONE));
        Assert.isNull(ReportsDefinition.restGranularity(null));
        Assert.areEqual('Desc', ReportsDefinition.restSortOrder(Reports.ColumnSortOrder.DESCENDING));
        Assert.isNull(ReportsDefinition.restSortOrder(null));
        Assert.areEqual('10', ReportsDefinition.filterValue(10.0));
        Assert.areEqual('7', ReportsDefinition.filterValue(7L));
    }
}
