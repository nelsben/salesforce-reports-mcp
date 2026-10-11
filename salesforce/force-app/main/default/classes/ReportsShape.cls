/**
 * Reports.ReportResults to ReportResult, ported from src/reports/shape.ts.
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

    /** Stop with the error shape before the heap limit, which Apex cannot catch. */
    public static void guardHeap() {
        if (Limits.getHeapSize() > Limits.getLimitHeapSize() * 0.8) {
            throw ReportsApi.apiError(500, 'RESULT_TOO_LARGE', 'The report result is too large for the in-org door\'s memory.',
                'Narrow the filters, lower maxRows, drop columns, or use the local server.');
        }
    }

    class Leaf {
        String key;
        List<Object> labels;
        Leaf(String key, List<Object> labels) {
            this.key = key;
            this.labels = labels;
        }
    }

    public static Map<String, Object> shapeResult(Reports.ReportResults raw, Integer maxRowsIn, Boolean includeDetail, String baseUrl, List<String> notesIn) {
        Map<String, Object> meta = ReportsSummary.metadataMap(raw.getReportMetadata());
        ReportsSummary.InfoMaps maps = ReportsSummary.infoMaps(raw.getReportExtendedMetadata());
        Map<String, Reports.ReportFact> factMap = raw.getFactMap() == null ? new Map<String, Reports.ReportFact>() : raw.getFactMap();
        Integer requested = Math.min(Math.max(maxRowsIn, 0), HARD_ROW_CEILING);
        List<String> notes = notesIn == null ? new List<String>() : new List<String>(notesIn);
        String id = (String) meta.get('id');
        String format = (String) meta.get('reportFormat');

        List<String> downNames = names((List<Object>) meta.get('groupingsDown'));
        List<String> acrossNames = names((List<Object>) meta.get('groupingsAcross'));
        List<Object> dimensions = new List<Object>();
        for (String name : downNames) dimensions.add(new Map<String, Object>{ 'name' => name, 'label' => ReportsSummary.columnLabel(name, maps), 'axis' => 'down' });
        for (String name : acrossNames) dimensions.add(new Map<String, Object>{ 'name' => name, 'label' => ReportsSummary.columnLabel(name, maps), 'axis' => 'across' });
        Boolean grouped = !dimensions.isEmpty();

        List<String> measureNames = (List<String>) meta.get('aggregates');
        List<Object> measures = new List<Object>();
        List<String> measureTypes = new List<String>();
        for (String name : measureNames) {
            Map<String, String> info = maps.aggregate.get(name);
            String label = info == null ? null : info.get('label');
            String dt = info == null ? null : info.get('dataType');
            measures.add(new Map<String, Object>{ 'name' => name, 'label' => label != null ? label : ReportsSummary.humanize(name), 'dataType' => dt != null ? dt : 'double' });
            measureTypes.add(dt != null ? dt : 'double');
        }

        Map<String, Object> report = new Map<String, Object>{ 'id' => id, 'name' => meta.get('name') != null ? meta.get('name') : 'Unsaved report', 'format' => format };
        Map<String, Object> type = (Map<String, Object>) meta.get('reportType');
        if (type != null && type.get('type') != null) report.put('reportType', type.get('type'));
        String url = ReportsSummary.reportUrl(baseUrl, id);
        if (url != null) report.put('url', url);
        Map<String, Object> result = new Map<String, Object>{
            'report' => report,
            'filters' => ReportsSummary.describeFilters(meta, maps),
            'notes' => notes
        };

        Reports.ReportFact grandTotal = factMap.get('T!T');
        if (grandTotal != null && grandTotal.getAggregates() != null) {
            result.put('totals', new Map<String, Object>{ 'measures' => measureNames, 'values' => aggregates(new List<Object>(), grandTotal.getAggregates(), measureTypes) });
        }

        // Walk the leaf combinations once. They carry both the group rows and the detail rows.
        List<String> detailColumnNames = (List<String>) meta.get('detailColumns');
        Integer columnCount = dimensions.size() + detailColumnNames.size();
        Integer ceiling = inOrgCeiling(columnCount);
        Integer maxRows = Math.min(requested, ceiling);
        List<Leaf> combos = new List<Leaf>();
        if (!grouped) {
            combos.add(new Leaf('T!T', new List<Object>()));
        } else {
            List<Leaf> downs = downNames.isEmpty() ? new List<Leaf>{ new Leaf('T', new List<Object>()) } : leaves(raw.getGroupingsDown() == null ? null : raw.getGroupingsDown().getGroupings(), new List<Object>());
            List<Leaf> acrosses = acrossNames.isEmpty() ? new List<Leaf>{ new Leaf('T', new List<Object>()) } : leaves(raw.getGroupingsAcross() == null ? null : raw.getGroupingsAcross().getGroupings(), new List<Object>());
            for (Leaf d : downs) {
                for (Leaf a : acrosses) {
                    List<Object> labels = new List<Object>(d.labels);
                    labels.addAll(a.labels);
                    combos.add(new Leaf(d.key + '!' + a.key, labels));
                }
            }
        }
        List<Object> groupRows = new List<Object>();
        List<Object> detailRows = new List<Object>();
        Integer total = 0;
        for (Leaf combo : combos) {
            Reports.ReportFact fact = factMap.get(combo.key);
            if (fact == null) continue;
            if (grouped) groupRows.add(aggregates(new List<Object>(combo.labels), fact.getAggregates(), measureTypes));
            if (!(fact instanceof Reports.ReportFactWithDetails)) continue;
            List<Reports.ReportDetailRow> rows = ((Reports.ReportFactWithDetails) fact).getRows();
            if (rows == null) continue;
            for (Reports.ReportDetailRow dr : rows) {
                total++;
                if (!includeDetail || detailRows.size() >= maxRows) continue;
                List<Object> row = new List<Object>(combo.labels);
                List<Reports.ReportDataCell> cells = dr.getDataCells();
                for (Integer i = 0; i < cells.size(); i++) {
                    String dt = maps.cellType(i < detailColumnNames.size() ? detailColumnNames[i] : '');
                    row.add(cell(cells[i].getValue(), cells[i].getLabel(), dt));
                }
                detailRows.add(row);
                if (Math.mod(detailRows.size(), 100) == 0) guardHeap();
            }
        }

        if (grouped) result.put('groups', new Map<String, Object>{ 'dimensions' => dimensions, 'measures' => measures, 'rows' => groupRows });

        Boolean allData = raw.getAllData() != false;
        if (includeDetail && (!grouped || total > 0 || format == 'TABULAR')) {
            List<Object> columns = new List<Object>();
            for (Object o : dimensions) {
                String name = (String) ((Map<String, Object>) o).get('name');
                String dt = maps.grouping.containsKey(name) ? maps.grouping.get(name).get('dataType') : null;
                columns.add(new Map<String, Object>{ 'name' => name, 'label' => ((Map<String, Object>) o).get('label'), 'dataType' => dt != null ? dt : 'string' });
            }
            for (String name : detailColumnNames) {
                String dt = maps.detail.containsKey(name) ? maps.detail.get(name).get('dataType') : null;
                columns.add(new Map<String, Object>{ 'name' => name, 'label' => ReportsSummary.columnLabel(name, maps), 'dataType' => dt != null ? dt : 'string' });
            }
            Boolean cut = total > maxRows;
            result.put('detail', new Map<String, Object>{ 'columns' => columns, 'rows' => detailRows, 'rowCount' => total, 'truncated' => cut || !allData });
            if (cut && maxRows < requested) {
                notes.add('Showing ' + maxRows + ' of ' + total + ' detail rows. The in-org door returns at most ' + ceiling + ' rows for ' + columnCount
                    + ' columns (a 50,000-cell budget). Add filters, drop columns, or use the local server for more.');
            } else if (cut) {
                notes.add('Showing ' + maxRows + ' of ' + total + ' detail rows. Raise maxRows (up to ' + HARD_ROW_CEILING + ') or add filters.');
            }
        }

        if (!allData) notes.add('Salesforce stopped at 2,000 rows (allData is false), so the results are incomplete. Narrow the filters.');
        return result;
    }

    static List<Object> aggregates(List<Object> row, List<Reports.SummaryValue> values, List<String> types) {
        if (values == null) return row;
        for (Integer i = 0; i < values.size(); i++) row.add(cell(values[i].getValue(), values[i].getLabel(), i < types.size() ? types[i] : null));
        return row;
    }

    static List<String> names(List<Object> groupings) {
        List<String> out = new List<String>();
        for (Object g : groupings) out.add((String) ((Map<String, Object>) g).get('name'));
        return out;
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
