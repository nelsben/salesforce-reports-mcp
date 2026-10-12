/**
 * Core layer: the friendly ReportDefinition behind run_report's `overrides`, query_report and the save tools, mapped to
 * REST-shaped reportMetadata exactly as src/reports/definition.ts does, then onto a Reports.ReportMetadata for
 * ReportManager.runReport. It reads its input through ReportsInput and refuses with ReportsException.
 */
public with sharing class ReportsDefinition {
    /** Checked against a live org: the API silently turns any other value into None. */
    public static final List<String> DATE_GRANULARITIES = new List<String>{
        'None', 'Day', 'Week', 'Month', 'Quarter', 'Year', 'FiscalPeriod', 'FiscalQuarter', 'FiscalWeek', 'FiscalYear', 'MonthInYear', 'DayInMonth'
    };
    static final Map<String, String> PREFIX = new Map<String, String>{ 'sum' => 's!', 'avg' => 'a!', 'min' => 'm!', 'max' => 'mx!', 'unique' => 'u!' };
    static final Set<String> SORT_ORDERS = new Set<String>{ 'Asc', 'Desc' };

    public class Mapped {
        public Map<String, Object> metadata = new Map<String, Object>();
        public List<String> notes = new List<String>();
    }

    /**
     * Map the friendly definition to reportMetadata.
     * With `partial`, only the fields that were given are produced (for run overrides).
     */
    public static Mapped toReportMetadata(Map<String, Object> def, Boolean partial) {
        Mapped out = new Mapped();
        Map<String, Object> meta = out.metadata;

        String reportType = ReportsInput.optString(def, 'reportType');
        if (String.isNotEmpty(reportType)) meta.put('reportType', new Map<String, Object>{ 'type' => reportType });

        List<Map<String, Object>> down = groupings(def, 'groupingsDown', 3);
        List<Map<String, Object>> across = groupings(def, 'groupingsAcross', 2);
        String format = ReportsInput.optString(def, 'format');
        if (format != null && !new Set<String>{ 'TABULAR', 'SUMMARY', 'MATRIX' }.contains(format)) {
            throw ReportsException.invalidInput('format must be TABULAR, SUMMARY or MATRIX.');
        }
        if (format == null && !partial) format = across != null && !across.isEmpty() ? 'MATRIX' : (down != null && !down.isEmpty() ? 'SUMMARY' : 'TABULAR');
        if (format != null) meta.put('reportFormat', format);
        if (down != null) meta.put('groupingsDown', down);
        if (across != null) meta.put('groupingsAcross', across);

        // Salesforce requires every aggregated column to be a detail column too.
        List<Object> aggregatesIn = ReportsInput.optList(def, 'aggregates');
        List<String> aggregateNames = aggregatesIn == null ? null : mapAggregates(aggregatesIn);
        List<String> aggregated = aggregateColumns(aggregateNames);
        List<String> columns = ReportsInput.optStringList(def, 'columns');
        if (columns == null && !aggregated.isEmpty() && !partial) columns = new List<String>();
        if (columns != null) {
            Set<String> grouped = new Set<String>();
            for (List<Map<String, Object>> side : new List<List<Map<String, Object>>>{ down, across }) {
                if (side != null) for (Map<String, Object> g : side) grouped.add((String) g.get('name'));
            }
            List<String> kept = new List<String>();
            List<String> dropped = new List<String>();
            for (String c : columns) {
                if (grouped.contains(c)) dropped.add(c);
                else kept.add(c);
            }
            if (!dropped.isEmpty()) {
                out.notes.add('Left out ' + String.join(dropped, ', ') + ' from the detail columns because it is a grouping; Salesforce rejects a grouped column there.');
            }
            List<String> added = new List<String>();
            for (String c : aggregated) if (!kept.contains(c) && !grouped.contains(c)) added.add(c);
            if (!added.isEmpty()) out.notes.add('Added ' + String.join(added, ', ') + ' to the detail columns because an aggregate uses it; Salesforce requires that.');
            List<String> detailColumns = new List<String>(kept);
            detailColumns.addAll(added);
            meta.put('detailColumns', detailColumns);
        }

        if (aggregateNames != null) meta.put('aggregates', aggregateNames);
        else if (!partial) meta.put('aggregates', new List<String>{ 'RowCount' });

        List<Object> filters = ReportsInput.optList(def, 'filters');
        if (filters != null) {
            List<Object> mapped = new List<Object>();
            for (Object o : filters) {
                Map<String, Object> f = ReportsInput.asMap(o, 'filters');
                mapped.add(new Map<String, Object>{
                    'column' => ReportsInput.reqString(f, 'column'),
                    'operator' => ReportsInput.reqString(f, 'operator'),
                    'value' => filterValue(f.get('value'))
                });
            }
            meta.put('reportFilters', mapped);
        }
        String filterLogic = ReportsInput.optString(def, 'filterLogic');
        if (filterLogic != null) meta.put('reportBooleanFilter', filterLogic);

        Map<String, Object> dateFilter = ReportsInput.optMap(def, 'dateFilter');
        if (dateFilter != null) {
            String duration = ReportsInput.optString(dateFilter, 'duration');
            String startDate = ReportsInput.optString(dateFilter, 'startDate');
            String endDate = ReportsInput.optString(dateFilter, 'endDate');
            Map<String, Object> filterOut = new Map<String, Object>{ 'column' => ReportsInput.reqString(dateFilter, 'column') };
            String durationValue = duration != null ? duration : (String.isNotEmpty(startDate) || String.isNotEmpty(endDate) ? 'CUSTOM' : null);
            if (String.isNotEmpty(durationValue)) filterOut.put('durationValue', durationValue);
            if (String.isNotEmpty(startDate)) filterOut.put('startDate', startDate);
            if (String.isNotEmpty(endDate)) filterOut.put('endDate', endDate);
            meta.put('standardDateFilter', filterOut);
        }

        List<Object> sortBy = ReportsInput.optList(def, 'sortBy');
        if (sortBy != null) {
            List<Object> mapped = new List<Object>();
            for (Object o : sortBy) {
                Map<String, Object> s = ReportsInput.asMap(o, 'sortBy');
                mapped.add(new Map<String, Object>{ 'sortColumn' => ReportsInput.reqString(s, 'column'), 'sortOrder' => sortOrder(ReportsInput.reqString(s, 'order')) });
            }
            meta.put('sortBy', mapped);
        }
        Map<String, Object> topRows = ReportsInput.optMap(def, 'topRows');
        if (topRows != null) {
            meta.put('topRows', new Map<String, Object>{
                'rowLimit' => ReportsInput.optInt(topRows, 'rowLimit', 1, 2147483647),
                'direction' => sortOrder(ReportsInput.reqString(topRows, 'direction'))
            });
        }
        String scope = ReportsInput.optString(def, 'scope');
        if (String.isNotEmpty(scope)) meta.put('scope', scope);

        Map<String, Object> raw = ReportsInput.optMap(def, 'reportMetadata');
        if (raw != null) meta.putAll(raw);
        return out;
    }

    /** Source columns of the aggregates, for example s!AMOUNT gives AMOUNT. RowCount and formulas give none. */
    public static List<String> aggregateColumns(List<String> aggregates) {
        List<String> out = new List<String>();
        if (aggregates == null) return out;
        Pattern p = Pattern.compile('^(?:s|a|m|mx|u)!(.+)$');
        for (String name : aggregates) {
            Matcher m = p.matcher(name);
            if (m.matches() && !out.contains(m.group(1))) out.add(m.group(1));
        }
        return out;
    }

    /** Apply REST-shaped reportMetadata fields onto a saved report's metadata, for this run only. */
    public static void applyTo(Reports.ReportMetadata m, Map<String, Object> meta) {
        for (String key : meta.keySet()) {
            Object v = meta.get(key);
            try {
                switch on key {
                    when 'reportType' {
                        String type = (String) ReportsInput.asMap(v, 'reportType').get('type');
                        if (m.getReportType() == null || type != m.getReportType().getType()) {
                            throw ReportsException.invalidInput('A run cannot change the report type of a saved report.');
                        }
                    }
                    when 'reportFormat' {
                        m.setReportFormat(reportFormat((String) v));
                    }
                    when 'groupingsDown' {
                        m.setGroupingsDown(toGroupings(v));
                    }
                    when 'groupingsAcross' {
                        m.setGroupingsAcross(toGroupings(v));
                    }
                    when 'detailColumns' {
                        m.setDetailColumns(strings(v));
                    }
                    when 'aggregates' {
                        m.setAggregates(strings(v));
                    }
                    when 'reportFilters' {
                        List<Reports.ReportFilter> out = new List<Reports.ReportFilter>();
                        for (Object o : (List<Object>) v) {
                            Map<String, Object> f = (Map<String, Object>) o;
                            out.add(new Reports.ReportFilter((String) f.get('column'), (String) f.get('operator'), (String) f.get('value')));
                        }
                        m.setReportFilters(out);
                    }
                    when 'reportBooleanFilter' {
                        m.setReportBooleanFilter((String) v);
                    }
                    when 'standardDateFilter' {
                        Map<String, Object> f = (Map<String, Object>) v;
                        Reports.StandardDateFilter out = new Reports.StandardDateFilter();
                        out.setColumn((String) f.get('column'));
                        out.setDurationValue((String) f.get('durationValue'));
                        out.setStartDate((String) f.get('startDate'));
                        out.setEndDate((String) f.get('endDate'));
                        m.setStandardDateFilter(out);
                    }
                    when 'sortBy' {
                        List<Reports.SortColumn> out = new List<Reports.SortColumn>();
                        for (Object o : (List<Object>) v) {
                            Map<String, Object> s = (Map<String, Object>) o;
                            Reports.SortColumn c = new Reports.SortColumn();
                            c.setSortColumn((String) s.get('sortColumn'));
                            c.setSortOrder(columnSortOrder((String) s.get('sortOrder')));
                            out.add(c);
                        }
                        m.setSortBy(out);
                    }
                    when 'topRows' {
                        Map<String, Object> t = (Map<String, Object>) v;
                        Reports.TopRows out = new Reports.TopRows();
                        out.setRowLimit((Integer) t.get('rowLimit'));
                        out.setDirection(columnSortOrder((String) t.get('direction')));
                        m.setTopRows(out);
                    }
                    when 'scope' {
                        m.setScope((String) v);
                    }
                    when 'standardFilters' {
                        List<Reports.StandardFilter> out = new List<Reports.StandardFilter>();
                        for (Object o : (List<Object>) v) {
                            Map<String, Object> s = (Map<String, Object>) o;
                            Reports.StandardFilter f = new Reports.StandardFilter();
                            f.setName((String) s.get('name'));
                            f.setValue((String) s.get('value'));
                            out.add(f);
                        }
                        m.setStandardFilters(out);
                    }
                    when else {
                        throw ReportsException.invalidInput('reportMetadata.' + key + ' is not supported on the in-org door. Use the local server for it.');
                    }
                }
            } catch (TypeException e) {
                throw ReportsException.invalidInput('reportMetadata.' + key + ' has the wrong shape: ' + e.getMessage());
            }
        }
    }

    // ---- REST names to and from Apex enums ----

    /** FISCAL_QUARTER gives FiscalQuarter, NONE gives None. */
    public static String restGranularity(Reports.DateGranularity value) {
        if (value == null) return null;
        List<String> words = new List<String>();
        for (String w : value.name().toLowerCase().split('_')) words.add(w.capitalize());
        return String.join(words, '');
    }

    public static String restSortOrder(Reports.ColumnSortOrder value) {
        return value == null ? null : (value == Reports.ColumnSortOrder.DESCENDING ? 'Desc' : 'Asc');
    }

    static Reports.DateGranularity granularity(String value) {
        for (Reports.DateGranularity g : Reports.DateGranularity.values()) if (restGranularity(g) == value) return g;
        throw ReportsException.invalidInput('dateGranularity must be one of ' + String.join(DATE_GRANULARITIES, ', ') + '.');
    }

    static Reports.ColumnSortOrder columnSortOrder(String value) {
        return value == 'Desc' ? Reports.ColumnSortOrder.DESCENDING : Reports.ColumnSortOrder.ASCENDING;
    }

    static Reports.ReportFormat reportFormat(String value) {
        for (Reports.ReportFormat f : Reports.ReportFormat.values()) if (f.name() == value) return f;
        throw ReportsException.invalidInput('format must be TABULAR, SUMMARY or MATRIX.');
    }

    // ---- input pieces ----

    static List<Map<String, Object>> groupings(Map<String, Object> def, String key, Integer max) {
        List<Object> raw = ReportsInput.optList(def, key);
        if (raw == null) return null;
        if (raw.size() > max) throw ReportsException.invalidInput(key + ' takes at most ' + max + ' groupings.');
        List<Map<String, Object>> out = new List<Map<String, Object>>();
        for (Object o : raw) {
            Map<String, Object> g = ReportsInput.asMap(o, key);
            String order = ReportsInput.optString(g, 'sortOrder');
            String grain = ReportsInput.optString(g, 'dateGranularity');
            if (grain != null && !DATE_GRANULARITIES.contains(grain)) {
                throw ReportsException.invalidInput('dateGranularity must be one of ' + String.join(DATE_GRANULARITIES, ', ') + '.');
            }
            out.add(new Map<String, Object>{
                'name' => ReportsInput.reqString(g, 'column'),
                'sortOrder' => order == null ? 'Asc' : sortOrder(order),
                'dateGranularity' => grain == null ? 'None' : grain
            });
        }
        return out;
    }

    /** Aggregates as reportMetadata names: {fn, column} gives the prefixed name, a string stays as given. */
    public static List<String> mapAggregates(List<Object> aggregates) {
        List<String> out = new List<String>();
        for (Object a : aggregates) {
            if (a instanceof String) {
                out.add((String) a);
                continue;
            }
            Map<String, Object> m = ReportsInput.asMap(a, 'aggregates');
            String fn = ReportsInput.reqString(m, 'fn');
            if (!PREFIX.containsKey(fn)) throw ReportsException.invalidInput('An aggregate fn is sum, avg, min, max or unique.');
            out.add(PREFIX.get(fn) + ReportsInput.reqString(m, 'column'));
        }
        return out;
    }

    static String sortOrder(String value) {
        if (!SORT_ORDERS.contains(value)) throw ReportsException.invalidInput('A sort order is Asc or Desc.');
        return value;
    }

    /** As JavaScript's String(value) writes a filter value. */
    @TestVisible
    static String filterValue(Object value) {
        if (value == null) throw ReportsException.invalidInput('A filter needs a value.');
        if (value instanceof String) return (String) value;
        if (value instanceof Boolean || value instanceof Integer || value instanceof Long) return String.valueOf(value);
        if (value instanceof Decimal) return ((Decimal) value).stripTrailingZeros().toPlainString();
        throw ReportsException.invalidInput('A filter value is a string, number or boolean.');
    }

    static List<String> strings(Object value) {
        List<String> out = new List<String>();
        for (Object o : (List<Object>) value) out.add((String) o);
        return out;
    }

    static List<Reports.GroupingInfo> toGroupings(Object value) {
        List<Reports.GroupingInfo> out = new List<Reports.GroupingInfo>();
        for (Object o : (List<Object>) value) {
            Map<String, Object> g = (Map<String, Object>) o;
            Reports.GroupingInfo info = new Reports.GroupingInfo();
            info.setName((String) g.get('name'));
            info.setSortOrder(columnSortOrder((String) g.get('sortOrder')));
            info.setDateGranularity(granularity(g.get('dateGranularity') == null ? 'None' : (String) g.get('dateGranularity')));
            out.add(info);
        }
        return out;
    }
}
