// Probes 3, 4 and 5: callouts, heap and CPU, and describeReport.
// Dispatches on the last path segment: GET /reportsprobelab/v1/<op>, POST for the callouts that write.
@RestResource(urlMapping='/reportsprobelab/v1/*')
global with sharing class ReportsProbeLab {
    private static final String API = '/services/data/v62.0';

    @HttpGet
    global static void doGet() {
        RestRequest req = RestContext.request;
        String op = req.requestURI.substringAfterLast('/');
        Object out;
        try {
            if (op == 'types') out = callout('GET', API + '/analytics/reportTypes', null);
            else if (op == 'typeOpportunity') out = callout('GET', API + '/analytics/reportTypes/Opportunity', null);
            else if (op == 'describe') out = describe(req.params.get('id'));
            else if (op == 'run') out = run(req.params.get('id'), Integer.valueOf(req.params.get('pad') == null ? '0' : req.params.get('pad')));
            else if (op == 'synthetic') out = synthetic(Integer.valueOf(req.params.get('rows')), Integer.valueOf(req.params.get('cols')));
            else out = new Map<String, Object>{ 'error' => 'unknown op ' + op };
        } catch (Exception e) {
            out = new Map<String, Object>{ 'error' => e.getTypeName() + ': ' + e.getMessage() };
        }
        RestContext.response.addHeader('Content-Type', 'application/json');
        RestContext.response.responseBody = Blob.valueOf(JSON.serialize(out));
    }

    @HttpPost
    global static void doPost() {
        RestRequest req = RestContext.request;
        String op = req.requestURI.substringAfterLast('/');
        Object out;
        try {
            if (op == 'query') out = callout('POST', API + '/analytics/reports/query', req.requestBody.toString());
            else if (op == 'createdelete') out = createDelete(req.requestBody.toString());
            else out = new Map<String, Object>{ 'error' => 'unknown op ' + op };
        } catch (Exception e) {
            out = new Map<String, Object>{ 'error' => e.getTypeName() + ': ' + e.getMessage() };
        }
        RestContext.response.addHeader('Content-Type', 'application/json');
        RestContext.response.responseBody = Blob.valueOf(JSON.serialize(out));
    }

    // Probe 3: a callout to the org's own REST API with the running user's session.
    private static Map<String, Object> callout(String method, String path, String body) {
        HttpRequest r = new HttpRequest();
        r.setEndpoint(URL.getOrgDomainUrl().toExternalForm() + path);
        r.setMethod(method);
        r.setHeader('Authorization', 'Bearer ' + UserInfo.getSessionId());
        r.setHeader('Content-Type', 'application/json');
        if (body != null) r.setBody(body);
        HttpResponse res = new Http().send(r);
        String b = res.getBody();
        Map<String, Object> o = new Map<String, Object>{ 'status' => res.getStatusCode(), 'bytes' => b == null ? 0 : b.length() };
        if (res.getStatusCode() >= 200 && res.getStatusCode() < 300 && b != null && b.length() > 0) {
            Object parsed = JSON.deserializeUntyped(b);
            if (parsed instanceof List<Object>) o.put('items', ((List<Object>) parsed).size());
            else if (parsed instanceof Map<String, Object>) o.put('keys', ((Map<String, Object>) parsed).keySet());
        } else {
            o.put('body', b == null ? null : b.left(400));
        }
        return o;
    }

    private static Map<String, Object> createDelete(String body) {
        Map<String, Object> o = new Map<String, Object>();
        HttpRequest r = new HttpRequest();
        r.setEndpoint(URL.getOrgDomainUrl().toExternalForm() + API + '/analytics/reports');
        r.setMethod('POST');
        r.setHeader('Authorization', 'Bearer ' + UserInfo.getSessionId());
        r.setHeader('Content-Type', 'application/json');
        r.setBody(body);
        HttpResponse res = new Http().send(r);
        o.put('createStatus', res.getStatusCode());
        if (res.getStatusCode() != 200 && res.getStatusCode() != 201) {
            o.put('createBody', res.getBody().left(400));
            return o;
        }
        Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        Map<String, Object> meta = (Map<String, Object>) parsed.get('reportMetadata');
        String id = (String) meta.get('id');
        o.put('createdIdPrefix', id.left(3));
        HttpRequest d = new HttpRequest();
        d.setEndpoint(URL.getOrgDomainUrl().toExternalForm() + API + '/analytics/reports/' + id);
        d.setMethod('DELETE');
        d.setHeader('Authorization', 'Bearer ' + UserInfo.getSessionId());
        HttpResponse dr = new Http().send(d);
        o.put('deleteStatus', dr.getStatusCode());
        if (dr.getStatusCode() >= 300) o.put('deleteBody', dr.getBody().left(400));
        return o;
    }

    // Probe 5: what describeReport gives without a callout.
    private static Map<String, Object> describe(Id reportId) {
        Reports.ReportDescribeResult d = Reports.ReportManager.describeReport(reportId);
        Reports.ReportTypeMetadata tm = d.getReportTypeMetadata();
        Map<String, Object> o = new Map<String, Object>();
        o.put('reportType', d.getReportMetadata().getReportType().getType());
        List<Object> sections = new List<Object>();
        Integer cols = 0;
        List<String> sample = new List<String>();
        for (Reports.ReportTypeColumnCategory cat : tm.getCategories()) {
            Map<String, Object> s = new Map<String, Object>{ 'label' => cat.getLabel() };
            Integer n = 0;
            for (String key : cat.getColumns().keySet()) {
                Reports.ReportTypeColumn c = cat.getColumns().get(key);
                n++;
                if (sample.size() < 3) sample.add(c.getName() + '|' + c.getLabel() + '|' + c.getDataType());
            }
            s.put('columns', n);
            cols += n;
            sections.add(s);
        }
        o.put('sections', sections);
        o.put('totalColumns', cols);
        List<String> all = new List<String>();
        for (Reports.ReportTypeColumnCategory cat : tm.getCategories()) {
            for (String key : cat.getColumns().keySet()) {
                Reports.ReportTypeColumn c = cat.getColumns().get(key);
                all.add(cat.getLabel() + '|' + c.getName() + '|' + c.getLabel() + '|' + c.getDataType());
            }
        }
        o.put('allColumns', all);
        o.put('sampleColumns', sample);
        o.put('detailColumnsInMetadata', d.getReportMetadata().getDetailColumns());
        return o;
    }

    // Probe 4, real run: run a saved report with details and shape it.
    private static Map<String, Object> run(Id reportId, Integer pad) {
        Integer heap0 = Limits.getHeapSize();
        Integer cpu0 = Limits.getCpuTime();
        Reports.ReportResults rr = Reports.ReportManager.runReport(reportId, true);
        Integer heapRun = Limits.getHeapSize();
        Integer cpuRun = Limits.getCpuTime();
        Map<String, Object> shaped = shape(rr);
        Map<String, Object> o = new Map<String, Object>();
        o.put('rows', shaped.get('rowCount'));
        o.put('cols', shaped.get('colCount'));
        o.put('heapBefore', heap0);
        o.put('heapAfterRun', heapRun);
        o.put('heapAfterShape', Limits.getHeapSize());
        o.put('cpuAfterRun', cpuRun - cpu0);
        o.put('cpuAfterShape', Limits.getCpuTime() - cpu0);
        o.put('jsonBytes', JSON.serialize(shaped).length());
        o.put('heapAfterJson', Limits.getHeapSize());
        o.put('heapLimit', Limits.getLimitHeapSize());
        o.put('cpuLimit', Limits.getLimitCpuTime());
        return o;
    }

    private static Map<String, Object> shape(Reports.ReportResults rr) {
        Reports.ReportExtendedMetadata em = rr.getReportExtendedMetadata();
        List<String> names = rr.getReportMetadata().getDetailColumns();
        List<Object> columns = new List<Object>();
        for (String n : names) {
            Reports.DetailColumn dc = em.getDetailColumnInfo().get(n);
            columns.add(new Map<String, Object>{ 'name' => n, 'label' => dc.getLabel(), 'dataType' => String.valueOf(dc.getDataType()) });
        }
        List<Object> rows = new List<Object>();
        Reports.ReportFactWithDetails fact = (Reports.ReportFactWithDetails) rr.getFactMap().get('T!T');
        if (fact != null) {
            for (Reports.ReportDetailRow dr : fact.getRows()) {
                List<Object> row = new List<Object>();
                for (Reports.ReportDataCell cell : dr.getDataCells()) row.add(cell.getValue() == null ? cell.getLabel() : cell.getValue());
                rows.add(row);
            }
        }
        return new Map<String, Object>{ 'columns' => columns, 'rows' => rows, 'rowCount' => rows.size(), 'colCount' => columns.size() };
    }

    // Probe 4, extrapolation aid: build the same shape from synthetic cells, because the org holds almost no records.
    private static Map<String, Object> synthetic(Integer rowsN, Integer colsN) {
        Integer cpu0 = Limits.getCpuTime();
        Integer heap0 = Limits.getHeapSize();
        List<Object> columns = new List<Object>();
        for (Integer c = 0; c < colsN; c++) columns.add(new Map<String, Object>{ 'name' => 'COL_' + c, 'label' => 'Column ' + c, 'dataType' => Math.mod(c, 2) == 0 ? 'string' : 'currency' });
        List<Object> rows = new List<Object>();
        for (Integer r = 0; r < rowsN; r++) {
            List<Object> row = new List<Object>();
            for (Integer c = 0; c < colsN; c++) row.add(Math.mod(c, 2) == 0 ? (Object) ('Value ' + r + ' ' + c) : (Object) (r * 1.5 + c));
            rows.add(row);
        }
        Map<String, Object> shaped = new Map<String, Object>{ 'columns' => columns, 'rows' => rows };
        Integer heapShape = Limits.getHeapSize();
        Integer cpuShape = Limits.getCpuTime() - cpu0;
        Integer bytes = JSON.serialize(shaped).length();
        return new Map<String, Object>{
            'rows' => rowsN, 'cols' => colsN,
            'heapBefore' => heap0, 'heapAfterShape' => heapShape, 'heapAfterJson' => Limits.getHeapSize(),
            'cpuShape' => cpuShape, 'cpuAfterJson' => Limits.getCpuTime() - cpu0,
            'jsonBytes' => bytes, 'heapLimit' => Limits.getLimitHeapSize(), 'cpuLimit' => Limits.getLimitCpuTime()
        };
    }
}
