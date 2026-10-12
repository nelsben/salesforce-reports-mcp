// Callout time and heap of a query_report with detail rows (docs/probes/v0.2-phase3.md). Creates and changes nothing.
// Run: sf apex run -f salesforce/scripts/measure-query.apex -o <alias>, then read the MEASURE lines.

List<Object> columns = new List<Object>{ 'OPPORTUNITY_NAME', 'ACCOUNT_NAME', 'AMOUNT', 'STAGE_NAME', 'CLOSE_DATE', 'PROBABILITY', 'TYPE', 'LEAD_SOURCE' };
Map<String, Map<String, Object>> cases = new Map<String, Map<String, Object>>{
    'tabular, 8 columns, maxRows 2000' => new Map<String, Object>{ 'reportType' => 'Opportunity', 'columns' => columns, 'detail' => true, 'maxRows' => 2000 },
    'summary by stage, 8 columns, detail, maxRows 2000' => new Map<String, Object>{
        'reportType' => 'Opportunity', 'columns' => columns, 'groupingsDown' => new List<Object>{ new Map<String, Object>{ 'column' => 'STAGE_NAME' } },
        'aggregates' => new List<Object>{ 'RowCount', new Map<String, Object>{ 'fn' => 'sum', 'column' => 'AMOUNT' } }, 'detail' => true, 'maxRows' => 2000
    }
};
System.debug('MEASURE|limits|heap ' + Limits.getLimitHeapSize() + '|cpu ' + Limits.getLimitCpuTime());
System.debug('MEASURE|header|case|rows|columns|callout+parse ms|heap after parse|shape ms|heap after shape|response bytes|cpu');

for (String name : cases.keySet()) {
    Map<String, Object> input = cases.get(name);
    Map<String, Object> def = new Map<String, Object>(input);
    def.remove('detail');
    def.remove('maxRows');
    ReportsDefinition.Mapped mapped = ReportsDefinition.toReportMetadata(def, false);
    Integer h0 = Limits.getHeapSize();
    Integer c0 = Limits.getCpuTime();
    Long t0 = System.currentTimeMillis();
    // The same call queryToResult makes, through the one callout helper.
    Map<String, Object> raw = (Map<String, Object>) ReportsCallout.send('POST', '/analytics/reports/query?includeDetails=true', new Map<String, Object>{ 'reportMetadata' => mapped.metadata });
    Long t1 = System.currentTimeMillis();
    Integer hParse = Limits.getHeapSize() - h0;
    Map<String, Object> shaped = ReportsShape.shapeJson(raw, 2000, true, ReportsService.baseUrl(), new List<String>());
    Long t2 = System.currentTimeMillis();
    Integer hShape = Limits.getHeapSize() - h0;
    Integer bytes = Blob.valueOf(JSON.serialize(shaped)).size();
    Map<String, Object> detail = (Map<String, Object>) shaped.get('detail');
    System.debug('MEASURE|case|' + name + '|' + detail.get('rowCount') + '|' + ((List<Object>) detail.get('columns')).size() + '|' + (t1 - t0) + '|' + hParse + '|' + (t2 - t1) + '|' + hShape + '|' + bytes + '|' + (Limits.getCpuTime() - c0));
    raw = null;
    shaped = null;
}

// The whole tool, as the door runs it.
Integer h0 = Limits.getHeapSize();
Long t0 = System.currentTimeMillis();
ReportsApi.Answer answer = ReportsApi.handle('query_report', JSON.serialize(cases.values()[0]));
System.debug('MEASURE|handle|status ' + answer.status + '|ms ' + (System.currentTimeMillis() - t0) + '|heap ' + (Limits.getHeapSize() - h0) + '|callouts ' + Limits.getCallouts());
