/**
 * Core layer: a report run to ReportResult, ported from src/reports/shape.ts. Two inputs share one frame: shapeResult
 * reads the Reports.ReportResults of ReportManager.runReport (run_report), and shapeJson reads the REST JSON of
 * /analytics/reports/query (query_report). The header, the row budget, the detail table and the notes are built once.
 * Detail rows past the cap are counted but never built, to keep heap low.
 */
public with sharing class ReportsShape {
    public static final Integer HARD_ROW_CEILING = 2000;
    /** About 105 bytes of heap per cell (phase 0, probe 4), so 50,000 cells stay well inside the synchronous heap. */
    public static final Integer CELL_BUDGET = 50000;

    /** The in-org row ceiling for a result with this many detail columns: min(2000, floor(50000 / columns)). */
    public static Integer inOrgCeiling(Integer columns) {
        return Math.min(HARD_ROW_CEILING, CELL_BUDGET / Math.max(1, columns));
    }

    public static ReportsException tooLarge() {
        return ReportsException.failed('RESULT_TOO_LARGE', 'The report result is too large for the in-org door\'s memory.',
            'Narrow the filters, lower maxRows, drop columns, or use the local server.');
    }

    /** Stop with the error shape before the heap limit, which Apex cannot catch. */
    public static void guardHeap() {
        if (Limits.getHeapSize() > Limits.getLimitHeapSize() * 0.8) throw tooLarge();
    }

    class Leaf {
        String key;
        List<Object> labels;
        Leaf(String key, List<Object> labels) {
            this.key = key;
            this.labels = labels;
        }
    }

    /** What both inputs share: the header, the dimensions and measures, the row budget, and the rows walked so far. */
    class Frame {
        Map<String, Object> result;
        List<String> notes;
        ReportsSummary.InfoMaps maps;
        String format;
        List<String> downNames;
        List<String> acrossNames;
        List<String> measureNames;
        List<Object> dimensions = new List<Object>();
        List<Object> measures = new List<Object>();
        List<String> measureTypes = new List<String>();
        List<String> detailColumnNames;
        Boolean grouped;
        Boolean includeDetail;
        Integer requested;
        Integer columnCount;
        Integer ceiling;
        Integer maxRows;
        List<Object> groupRows = new List<Object>();
        List<Object> detailRows = new List<Object>();
        Integer total = 0;

        /** True while one more detail row should be built; every row is still counted. */
        Boolean wantsRow() {
            total++;
            return includeDetail && detailRows.size() < maxRows;
        }
    }

    static Frame frame(Map<String, Object> meta, ReportsSummary.InfoMaps maps, String id, String name, Integer maxRowsIn, Boolean includeDetail, String baseUrl, List<String> notesIn) {
        Frame f = new Frame();
        f.maps = maps;
        f.includeDetail = includeDetail;
        f.requested = Math.min(Math.max(maxRowsIn, 0), HARD_ROW_CEILING);
        f.notes = notesIn == null ? new List<String>() : new List<String>(notesIn);
        f.format = (String) meta.get('reportFormat');
        f.downNames = names(meta.get('groupingsDown'));
        f.acrossNames = names(meta.get('groupingsAcross'));
        for (String n : f.downNames) f.dimensions.add(new Map<String, Object>{ 'name' => n, 'label' => ReportsSummary.columnLabel(n, maps), 'axis' => 'down' });
        for (String n : f.acrossNames) f.dimensions.add(new Map<String, Object>{ 'name' => n, 'label' => ReportsSummary.columnLabel(n, maps), 'axis' => 'across' });
        f.grouped = !f.dimensions.isEmpty();

        f.measureNames = strings(meta.get('aggregates'));
        for (String n : f.measureNames) {
            Map<String, String> info = maps.aggregate.get(n);
            String label = info == null ? null : info.get('label');
            String dt = info == null ? null : info.get('dataType');
            f.measures.add(new Map<String, Object>{ 'name' => n, 'label' => label != null ? label : ReportsSummary.humanize(n), 'dataType' => dt != null ? dt : 'double' });
            f.measureTypes.add(dt != null ? dt : 'double');
        }

        Map<String, Object> report = new Map<String, Object>{ 'id' => id, 'name' => name != null ? name : 'Unsaved report', 'format' => f.format };
        Object type = meta.get('reportType');
        if (type instanceof Map<String, Object> && ((Map<String, Object>) type).get('type') != null) report.put('reportType', ((Map<String, Object>) type).get('type'));
        String url = ReportsSummary.reportUrl(baseUrl, id);
        if (url != null) report.put('url', url);
        f.result = new Map<String, Object>{ 'report' => report, 'filters' => ReportsSummary.describeFilters(meta, maps), 'notes' => f.notes };

        f.detailColumnNames = strings(meta.get('detailColumns'));
        f.columnCount = f.dimensions.size() + f.detailColumnNames.size();
        f.ceiling = inOrgCeiling(f.columnCount);
        f.maxRows = Math.min(f.requested, f.ceiling);
        return f;
    }

    /** The leaf combinations to walk, in the local server's order. A flat report has the one key T!T. */
    static List<Leaf> combos(Frame f, List<Leaf> downLeaves, List<Leaf> acrossLeaves) {
        List<Leaf> out = new List<Leaf>();
        if (!f.grouped) {
            out.add(new Leaf('T!T', new List<Object>()));
            return out;
        }
        List<Leaf> downs = f.downNames.isEmpty() ? new List<Leaf>{ new Leaf('T', new List<Object>()) } : downLeaves;
        List<Leaf> acrosses = f.acrossNames.isEmpty() ? new List<Leaf>{ new Leaf('T', new List<Object>()) } : acrossLeaves;
        for (Leaf d : downs) {
            for (Leaf a : acrosses) {
                List<Object> labels = new List<Object>(d.labels);
                labels.addAll(a.labels);
                out.add(new Leaf(d.key + '!' + a.key, labels));
            }
        }
        return out;
    }

    static Map<String, Object> finish(Frame f, List<Object> totals, Boolean allData) {
        Map<String, Object> result = f.result;
        if (totals != null) result.put('totals', new Map<String, Object>{ 'measures' => f.measureNames, 'values' => totals });
        if (f.grouped) result.put('groups', new Map<String, Object>{ 'dimensions' => f.dimensions, 'measures' => f.measures, 'rows' => f.groupRows });
        if (f.includeDetail && (!f.grouped || f.total > 0 || f.format == 'TABULAR')) {
            List<Object> columns = new List<Object>();
            for (Object o : f.dimensions) {
                String name = (String) ((Map<String, Object>) o).get('name');
                String dt = f.maps.grouping.containsKey(name) ? f.maps.grouping.get(name).get('dataType') : null;
                columns.add(new Map<String, Object>{ 'name' => name, 'label' => ((Map<String, Object>) o).get('label'), 'dataType' => dt != null ? dt : 'string' });
            }
            for (String name : f.detailColumnNames) {
                String dt = f.maps.detail.containsKey(name) ? f.maps.detail.get(name).get('dataType') : null;
                columns.add(new Map<String, Object>{ 'name' => name, 'label' => ReportsSummary.columnLabel(name, f.maps), 'dataType' => dt != null ? dt : 'string' });
            }
            Boolean cut = f.total > f.maxRows;
            result.put('detail', new Map<String, Object>{ 'columns' => columns, 'rows' => f.detailRows, 'rowCount' => f.total, 'truncated' => cut || !allData });
            if (cut && f.maxRows < f.requested) {
                f.notes.add('Showing ' + f.maxRows + ' of ' + f.total + ' detail rows. The in-org door returns at most ' + f.ceiling + ' rows for ' + f.columnCount
                    + ' columns (a 50,000-cell budget). Add filters, drop columns, or use the local server for more.');
            } else if (cut) {
                f.notes.add('Showing ' + f.maxRows + ' of ' + f.total + ' detail rows. Raise maxRows (up to ' + HARD_ROW_CEILING + ') or add filters.');
            }
        }
        if (!allData) f.notes.add('Salesforce stopped at 2,000 rows (allData is false), so the results are incomplete. Narrow the filters.');
        return result;
    }

    // ---- run_report: Reports.ReportResults ----

    public static Map<String, Object> shapeResult(Reports.ReportResults raw, Integer maxRowsIn, Boolean includeDetail, String baseUrl, List<String> notesIn) {
        Map<String, Object> meta = ReportsSummary.metadataMap(raw.getReportMetadata());
        Map<String, Reports.ReportFact> factMap = raw.getFactMap() == null ? new Map<String, Reports.ReportFact>() : raw.getFactMap();
        Frame f = frame(meta, ReportsSummary.infoMaps(raw.getReportExtendedMetadata()), (String) meta.get('id'), (String) meta.get('name'), maxRowsIn, includeDetail, baseUrl, notesIn);

        Reports.ReportFact grandTotal = factMap.get('T!T');
        List<Object> totals = grandTotal != null && grandTotal.getAggregates() != null ? aggregates(new List<Object>(), grandTotal.getAggregates(), f.measureTypes) : null;

        // Walk the leaf combinations once. They carry both the group rows and the detail rows.
        List<Leaf> downLeaves = f.downNames.isEmpty() ? null : leaves(raw.getGroupingsDown() == null ? null : raw.getGroupingsDown().getGroupings(), new List<Object>());
        List<Leaf> acrossLeaves = f.acrossNames.isEmpty() ? null : leaves(raw.getGroupingsAcross() == null ? null : raw.getGroupingsAcross().getGroupings(), new List<Object>());
        for (Leaf combo : combos(f, downLeaves, acrossLeaves)) {
            Reports.ReportFact fact = factMap.get(combo.key);
            if (fact == null) continue;
            if (f.grouped) f.groupRows.add(aggregates(new List<Object>(combo.labels), fact.getAggregates(), f.measureTypes));
            if (!(fact instanceof Reports.ReportFactWithDetails)) continue;
            List<Reports.ReportDetailRow> rows = ((Reports.ReportFactWithDetails) fact).getRows();
            if (rows == null) continue;
            for (Reports.ReportDetailRow dr : rows) {
                if (!f.wantsRow()) continue;
                List<Object> row = new List<Object>(combo.labels);
                List<Reports.ReportDataCell> cells = dr.getDataCells();
                for (Integer i = 0; i < cells.size(); i++) {
                    row.add(cell(cells[i].getValue(), cells[i].getLabel(), f.maps.cellType(i < f.detailColumnNames.size() ? f.detailColumnNames[i] : '')));
                }
                f.detailRows.add(row);
                if (Math.mod(f.detailRows.size(), 100) == 0) guardHeap();
            }
        }
        return finish(f, totals, raw.getAllData() != false);
    }

    static List<Object> aggregates(List<Object> row, List<Reports.SummaryValue> values, List<String> types) {
        if (values == null) return row;
        for (Integer i = 0; i < values.size(); i++) row.add(cell(values[i].getValue(), values[i].getLabel(), i < types.size() ? types[i] : null));
        return row;
    }

    static List<Leaf> leaves(List<Reports.GroupingValue> nodes, List<Object> trail) {
        List<Leaf> out = new List<Leaf>();
        if (nodes == null) return out;
        for (Reports.GroupingValue node : nodes) {
            List<Object> labels = new List<Object>(trail);
            labels.add(groupLabel(node.getLabel()));
            List<Reports.GroupingValue> children = node.getGroupings();
            if (children != null && !children.isEmpty()) out.addAll(leaves(children, labels));
            else out.add(new Leaf(node.getKey(), labels));
        }
        return out;
    }

    // ---- query_report: the REST JSON of /analytics/reports/query ----

    /** The REST report result (reportMetadata, reportExtendedMetadata, groupings, factMap, allData) as a ReportResult. */
    public static Map<String, Object> shapeJson(Map<String, Object> raw, Integer maxRowsIn, Boolean includeDetail, String baseUrl, List<String> notesIn) {
        Map<String, Object> meta = jsonMap(raw.get('reportMetadata'));
        Map<String, Object> attributes = jsonMap(raw.get('attributes'));
        Map<String, Object> factMap = jsonMap(raw.get('factMap'));
        String id = str(meta.get('id') != null ? meta.get('id') : attributes.get('reportId'));
        String name = str(meta.get('name') != null ? meta.get('name') : attributes.get('reportName'));
        Frame f = frame(meta, ReportsSummary.infoMapsJson(jsonMap(raw.get('reportExtendedMetadata'))), id, name, maxRowsIn, includeDetail, baseUrl, notesIn);

        Map<String, Object> grandTotal = jsonMap(factMap.get('T!T'));
        List<Object> totals = grandTotal.get('aggregates') != null ? jsonAggregates(new List<Object>(), grandTotal.get('aggregates'), f.measureTypes) : null;

        List<Leaf> downLeaves = f.downNames.isEmpty() ? null : jsonLeaves(jsonMap(raw.get('groupingsDown')).get('groupings'), new List<Object>());
        List<Leaf> acrossLeaves = f.acrossNames.isEmpty() ? null : jsonLeaves(jsonMap(raw.get('groupingsAcross')).get('groupings'), new List<Object>());
        for (Leaf combo : combos(f, downLeaves, acrossLeaves)) {
            Object found = factMap.get(combo.key);
            if (found == null) continue;
            Map<String, Object> fact = (Map<String, Object>) found;
            if (f.grouped) f.groupRows.add(jsonAggregates(new List<Object>(combo.labels), fact.get('aggregates'), f.measureTypes));
            for (Object r : items(fact.get('rows'))) {
                if (!f.wantsRow()) continue;
                List<Object> row = new List<Object>(combo.labels);
                List<Object> cells = items(((Map<String, Object>) r).get('dataCells'));
                for (Integer i = 0; i < cells.size(); i++) {
                    Map<String, Object> c = (Map<String, Object>) cells[i];
                    row.add(cell(c.get('value'), str(c.get('label')), f.maps.cellType(i < f.detailColumnNames.size() ? f.detailColumnNames[i] : '')));
                }
                f.detailRows.add(row);
                if (Math.mod(f.detailRows.size(), 100) == 0) guardHeap();
            }
        }
        return finish(f, totals, raw.get('allData') != false);
    }

    static List<Object> jsonAggregates(List<Object> row, Object values, List<String> types) {
        List<Object> given = items(values);
        for (Integer i = 0; i < given.size(); i++) {
            Map<String, Object> a = (Map<String, Object>) given[i];
            row.add(cell(a.get('value'), str(a.get('label')), i < types.size() ? types[i] : null));
        }
        return row;
    }

    static List<Leaf> jsonLeaves(Object nodes, List<Object> trail) {
        List<Leaf> out = new List<Leaf>();
        for (Object o : items(nodes)) {
            Map<String, Object> node = (Map<String, Object>) o;
            List<Object> labels = new List<Object>(trail);
            labels.add(groupLabel(str(node.get('label'))));
            List<Object> children = items(node.get('groupings'));
            if (!children.isEmpty()) out.addAll(jsonLeaves(children, labels));
            else out.add(new Leaf(str(node.get('key')), labels));
        }
        return out;
    }

    // ---- shared helpers ----

    static List<String> names(Object groupings) {
        List<String> out = new List<String>();
        for (Object g : items(groupings)) out.add((String) ((Map<String, Object>) g).get('name'));
        return out;
    }

    /** A list of names, whether Apex built it (List<String>) or JSON did (List<Object>). */
    static List<String> strings(Object value) {
        List<String> out = new List<String>();
        for (Object o : items(value)) out.add(str(o));
        return out;
    }

    static List<Object> items(Object value) {
        return value instanceof List<Object> ? (List<Object>) value : new List<Object>();
    }

    static Map<String, Object> jsonMap(Object value) {
        return value instanceof Map<String, Object> ? (Map<String, Object>) value : new Map<String, Object>();
    }

    static String str(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    @TestVisible
    static Object groupLabel(String label) {
        return label == null || label == '-' ? null : label;
    }

    /**
     * One cell to one value. Numbers, currency and percent give a number; booleans a boolean;
     * dates their ISO string; everything else its display label. An empty cell gives null.
     */
    public static Object cell(Object value, String label, String dataType) {
        if (value == null) return null;
        if (value instanceof Reports.ReportCurrency) return ((Reports.ReportCurrency) value).getAmount();
        // REST writes a currency cell as {"amount": 12.5, "currency": null}.
        if (value instanceof Map<String, Object>) {
            Map<String, Object> m = (Map<String, Object>) value;
            Object amount = m.get('amount');
            if (isNumber(amount)) return amount;
            if (amount == null && m.containsKey('amount')) return null;
            return label != null ? label : '';
        }
        if (dataType == 'int' || dataType == 'double' || dataType == 'currency' || dataType == 'percent') {
            if (isNumber(value)) return value;
            try {
                return Decimal.valueOf(String.valueOf(value));
            } catch (Exception e) {
                return label != null ? label : String.valueOf(value);
            }
        }
        if (dataType == 'boolean') {
            if (value instanceof Boolean) return value;
            if (value instanceof String && (String) value == 'true') return true;
            if (value instanceof String && (String) value == 'false') return false;
            return label != null ? label : String.valueOf(value);
        }
        if (dataType == 'date' || dataType == 'datetime' || dataType == 'time') return isoString(value);
        // Lookup columns carry a record id in the value and the readable name in the label.
        if (label == null || label == '-') return value instanceof String || value instanceof Id ? (Object) String.valueOf(value) : null;
        return label;
    }

    static Boolean isNumber(Object value) {
        return value instanceof Integer || value instanceof Long || value instanceof Decimal || value instanceof Double;
    }

    /** A date as YYYY-MM-DD and a datetime as YYYY-MM-DDThh:mm:ssZ, as the REST API writes them. */
    @TestVisible
    static String isoString(Object value) {
        // A Date is an instance of Datetime in Apex, but a Datetime is not an instance of Date, so test Date first.
        if (value instanceof Date) return Datetime.newInstanceGmt((Date) value, Time.newInstance(0, 0, 0, 0)).formatGmt('yyyy-MM-dd');
        if (value instanceof Datetime) return ((Datetime) value).formatGmt('yyyy-MM-dd\'T\'HH:mm:ss\'Z\'');
        return String.valueOf(value);
    }
}
