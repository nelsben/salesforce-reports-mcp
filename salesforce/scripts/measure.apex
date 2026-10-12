// Heap and CPU of real runs through the door's own code (docs/probes/v0.2-phase1.md).
// Needs saved reports named zz-parity-measure-* (the doc says how to make them). Creates and changes nothing.
// Run: sf apex run -f salesforce/scripts/measure.apex -o <alias>, then read the MEASURE lines.

List<Report> saved = [SELECT Id, Name FROM Report WHERE Name LIKE 'zz-parity-measure-%' ORDER BY Name];
System.debug('MEASURE|limits|heap ' + Limits.getLimitHeapSize() + '|cpu ' + Limits.getLimitCpuTime());
System.debug('MEASURE|header|report|rows|columns|cells|heap run|heap run+shape|heap run+shape+body|body bytes|cpu run|cpu run+shape|cpu run+shape+body');

// 1. Each report alone, as runToResult does it: run, shape at the default 200 rows, serialize to the response body.
for (Report r : saved) {
    Integer h0 = Limits.getHeapSize();
    Integer c0 = Limits.getCpuTime();
    Reports.ReportResults rr = Reports.ReportManager.runReport(r.Id, true);
    Integer hRun = Limits.getHeapSize() - h0;
    Integer cRun = Limits.getCpuTime() - c0;
    Map<String, Object> shaped = ReportsShape.shapeResult(rr, ReportsService.DEFAULT_MAX_ROWS, true, ReportsService.baseUrl(), new List<String>());
    Integer hShape = Limits.getHeapSize() - h0;
    Integer cShape = Limits.getCpuTime() - c0;
    Blob body = Blob.valueOf(JSON.serialize(shaped));
    Integer hBody = Limits.getHeapSize() - h0;
    Integer cBody = Limits.getCpuTime() - c0;
    Map<String, Object> detail = (Map<String, Object>) shaped.get('detail');
    Integer rows = ((List<Object>) detail.get('rows')).size();
    Integer cols = ((List<Object>) detail.get('columns')).size();
    System.debug('MEASURE|alone|' + r.Name + '|' + rows + '|' + cols + '|' + (rows * cols) + '|' + hRun + '|' + hShape + '|' + hBody + '|' + body.size() + '|' + cRun + '|' + cShape + '|' + cBody);
    rr = null;
    shaped = null;
    body = null;
}

// 2. The widest report run k times with every run result, shaped result and body kept, which holds in heap what one
//    run k times as long would. Stops before the heap guard (80%) would.
Report widest = saved.isEmpty() ? null : saved[saved.size() - 1];
if (widest != null) {
    List<Object> kept = new List<Object>();
    Integer h0 = Limits.getHeapSize();
    Integer c0 = Limits.getCpuTime();
    Integer cells = 0;
    for (Integer k = 1; k <= 24; k++) {
        if (Limits.getHeapSize() > Limits.getLimitHeapSize() * 0.6) break;
        Reports.ReportResults rr = Reports.ReportManager.runReport(widest.Id, true);
        Map<String, Object> shaped = ReportsShape.shapeResult(rr, ReportsService.DEFAULT_MAX_ROWS, true, ReportsService.baseUrl(), new List<String>());
        Blob body = Blob.valueOf(JSON.serialize(shaped));
        kept.add(rr);
        kept.add(shaped);
        kept.add(body);
        Map<String, Object> detail = (Map<String, Object>) shaped.get('detail');
        cells += ((List<Object>) detail.get('rows')).size() * ((List<Object>) detail.get('columns')).size();
        if (k == 1 || k == 2 || k == 4 || k == 8 || k == 12 || k == 16 || k == 20 || k == 24) {
            System.debug('MEASURE|held|' + widest.Name + '|k ' + k + '|cells ' + cells + '|heap ' + (Limits.getHeapSize() - h0) + '|cpu ' + (Limits.getCpuTime() - c0));
        }
    }
}
