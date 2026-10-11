/**
 * Compact summaries of Apex report describes, ported from src/reports/summarize.ts.
 * Apex objects are first turned into the REST shapes (metadataMap, infoMaps) so the port reads like the TypeScript.
 */
public with sharing class ReportsSummary {
    /** Granularities for date groupings. Apex has no dateGranularityInfos; REST lists these nine for every type. */
    static final List<String> DATE_GRANULARITY_INFOS = new List<String>{
        'Day', 'Week', 'Month', 'Quarter', 'Year', 'FiscalQuarter', 'FiscalYear', 'MonthInYear', 'DayInMonth'
    };
    static final Map<String, String> OPERATOR_WORDS = new Map<String, String>{
        'equals' => 'equals',
        'notEqual' => 'not equal to',
        'lessThan' => 'less than',
        'greaterThan' => 'greater than',
        'lessOrEqual' => 'less or equal to',
        'greaterOrEqual' => 'greater or equal to',
        'contains' => 'contains',
        'notContain' => 'does not contain',
        'startsWith' => 'starts with',
        'includes' => 'includes',
        'excludes' => 'excludes',
        'within' => 'within'
    };

    /** Column info by name, as {label, dataType} with REST data types (string, currency ...). */
    public class InfoMaps {
        public Map<String, Map<String, String>> detail = new Map<String, Map<String, String>>();
        public Map<String, Map<String, String>> grouping = new Map<String, Map<String, String>>();
        public Map<String, Map<String, String>> aggregate = new Map<String, Map<String, String>>();

        public String detailLabel(String name) {
            return detail.containsKey(name) ? detail.get(name).get('label') : null;
        }
        /** The data type of a detail cell: its detail column, else its grouping column. */
        public String cellType(String name) {
            if (detail.containsKey(name)) return detail.get(name).get('dataType');
            return grouping.containsKey(name) ? grouping.get(name).get('dataType') : null;
        }
    }

    /** CURRENCY_DATA gives currency, as REST names it. */
    public static String dataType(Reports.ColumnDataType value) {
        return value == null ? null : value.name().toLowerCase().removeEnd('_data');
    }

    public static InfoMaps infoMaps(Reports.ReportExtendedMetadata extended) {
        InfoMaps maps = new InfoMaps();
        if (extended == null) return maps;
        Map<String, Reports.DetailColumn> detail = extended.getDetailColumnInfo();
        if (detail != null) for (String k : detail.keySet()) maps.detail.put(k, info(detail.get(k).getLabel(), dataType(detail.get(k).getDataType())));
        Map<String, Reports.GroupingColumn> grouping = extended.getGroupingColumnInfo();
        if (grouping != null) for (String k : grouping.keySet()) maps.grouping.put(k, info(grouping.get(k).getLabel(), dataType(grouping.get(k).getDataType())));
        Map<String, Reports.AggregateColumn> aggregate = extended.getAggregateColumnInfo();
        if (aggregate != null) for (String k : aggregate.keySet()) maps.aggregate.put(k, info(aggregate.get(k).getLabel(), dataType(aggregate.get(k).getDataType())));
        return maps;
    }

    public static Map<String, String> info(String label, String dataType) {
        return new Map<String, String>{ 'label' => label, 'dataType' => dataType };
    }

    /** A Reports.ReportMetadata as the REST reportMetadata object, for the fields Apex exposes. */
    public static Map<String, Object> metadataMap(Reports.ReportMetadata m) {
        Map<String, Object> out = new Map<String, Object>();
        Reports.ReportType type = m.getReportType();
        out.put('id', m.getId() == null ? null : String.valueOf(m.getId()));
        out.put('name', m.getName());
        out.put('developerName', m.getDeveloperName());
        out.put('description', m.getDescription());
        out.put('reportFormat', m.getReportFormat() == null ? null : m.getReportFormat().name());
        out.put('reportType', type == null ? null : new Map<String, Object>{ 'type' => type.getType(), 'label' => type.getLabel() });
        out.put('detailColumns', m.getDetailColumns() == null ? new List<String>() : m.getDetailColumns());
        out.put('groupingsDown', groupings(m.getGroupingsDown()));
        out.put('groupingsAcross', groupings(m.getGroupingsAcross()));
        out.put('aggregates', m.getAggregates() == null ? new List<String>() : m.getAggregates());
        List<Object> filters = new List<Object>();
        if (m.getReportFilters() != null) {
            for (Reports.ReportFilter f : m.getReportFilters()) {
                filters.add(new Map<String, Object>{ 'column' => f.getColumn(), 'operator' => f.getOperator(), 'value' => f.getValue(), 'filterType' => f.getFilterType() });
            }
        }
        out.put('reportFilters', filters);
        out.put('reportBooleanFilter', m.getReportBooleanFilter());
        Reports.StandardDateFilter d = m.getStandardDateFilter();
        out.put('standardDateFilter', d == null ? null : new Map<String, Object>{
            'column' => d.getColumn(), 'durationValue' => d.getDurationValue(), 'startDate' => d.getStartDate(), 'endDate' => d.getEndDate()
        });
        out.put('scope', m.getScope());
        List<Object> standard = new List<Object>();
        if (m.getStandardFilters() != null) {
            for (Reports.StandardFilter f : m.getStandardFilters()) standard.add(new Map<String, Object>{ 'name' => f.getName(), 'value' => f.getValue() });
        }
        out.put('standardFilters', standard);
        List<Object> sortBy = new List<Object>();
        if (m.getSortBy() != null) {
            for (Reports.SortColumn s : m.getSortBy()) sortBy.add(new Map<String, Object>{ 'sortColumn' => s.getSortColumn(), 'sortOrder' => ReportsDefinition.restSortOrder(s.getSortOrder()) });
        }
        out.put('sortBy', sortBy);
        Reports.TopRows top = m.getTopRows();
        out.put('topRows', top == null ? null : new Map<String, Object>{ 'rowLimit' => top.getRowLimit(), 'direction' => ReportsDefinition.restSortOrder(top.getDirection()) });
        out.put('hasDetailRows', m.getHasDetailRows());
        out.put('hasRecordCount', m.getHasRecordCount());
        out.put('showGrandTotal', m.getShowGrandTotal());
        out.put('showSubtotals', m.getShowSubtotals());
        out.put('currency', m.getCurrencyCode());
        out.put('division', m.getDivision());
        return out;
    }

    static List<Object> groupings(List<Reports.GroupingInfo> infos) {
        List<Object> out = new List<Object>();
        if (infos == null) return out;
        for (Reports.GroupingInfo g : infos) {
            out.add(new Map<String, Object>{
                'name' => g.getName(),
                'sortOrder' => ReportsDefinition.restSortOrder(g.getSortOrder()),
                'dateGranularity' => ReportsDefinition.restGranularity(g.getDateGranularity()),
                'sortAggregate' => g.getSortAggregate()
            });
        }
        return out;
    }

    public static String humanize(String name) {
        List<String> words = new List<String>();
        for (String w : name.replaceFirst('^[a-z]+!', '').toLowerCase().split('_')) {
            if (String.isNotEmpty(w)) words.add(w.substring(0, 1).toUpperCase() + w.substring(1));
        }
        return String.join(words, ' ');
    }

    public static String columnLabel(String name, InfoMaps maps) {
        for (Map<String, Map<String, String>> m : new List<Map<String, Map<String, String>>>{ maps.detail, maps.grouping, maps.aggregate }) {
            if (m.containsKey(name) && m.get(name).get('label') != null) return m.get(name).get('label');
        }
        return humanize(name);
    }

    /** Plain-language filter lines, including the date filter, scope and Salesforce's built-in standard filters. */
    public static List<String> describeFilters(Map<String, Object> meta, InfoMaps maps) {
        List<String> lines = new List<String>();
        Map<String, Object> dateFilter = (Map<String, Object>) meta.get('standardDateFilter');
        if (dateFilter != null && String.isNotEmpty((String) dateFilter.get('column'))) {
            String duration = (String) dateFilter.get('durationValue');
            String range = String.isNotEmpty(duration) && duration != 'CUSTOM'
                ? duration
                : orDots((String) dateFilter.get('startDate')) + ' to ' + orDots((String) dateFilter.get('endDate'));
            lines.add(columnLabel((String) dateFilter.get('column'), maps) + ': ' + range);
        }
        List<Object> filters = meta.get('reportFilters') == null ? new List<Object>() : (List<Object>) meta.get('reportFilters');
        for (Integer i = 0; i < filters.size(); i++) {
            Map<String, Object> f = (Map<String, Object>) filters[i];
            String op = (String) f.get('operator');
            if (OPERATOR_WORDS.containsKey(op)) op = OPERATOR_WORDS.get(op);
            Object value = f.get('value');
            lines.add(((filters.size() > 1 ? (i + 1) + '. ' : '') + columnLabel((String) f.get('column'), maps) + ' ' + op + ' ' + (value == null ? '' : String.valueOf(value))).trim());
        }
        String logic = (String) meta.get('reportBooleanFilter');
        if (String.isNotEmpty(logic) && filters.size() > 1) lines.add('Filter logic: ' + logic);
        String scope = (String) meta.get('scope');
        if (String.isNotEmpty(scope)) lines.add('Scope: ' + scope);
        if (meta.get('standardFilters') != null) {
            for (Object o : (List<Object>) meta.get('standardFilters')) {
                Map<String, Object> sf = (Map<String, Object>) o;
                lines.add('Standard filter ' + sf.get('name') + ': ' + sf.get('value'));
            }
        }
        return lines;
    }

    static String orDots(String value) {
        return value == null ? '...' : value;
    }

    public static String reportUrl(String baseUrl, String id) {
        return String.isNotEmpty(baseUrl) && String.isNotEmpty(id) ? baseUrl + '/lightning/r/Report/' + id + '/view' : null;
    }

    public static Map<String, Object> summarizeReport(Map<String, Object> meta, InfoMaps maps, String baseUrl, Boolean includeMetadata) {
        Map<String, Object> summary = new Map<String, Object>();
        String id = (String) meta.get('id');
        Map<String, Object> type = (Map<String, Object>) meta.get('reportType');
        summary.put('id', id);
        summary.put('name', meta.get('name'));
        summary.put('developerName', meta.get('developerName'));
        summary.put('description', meta.get('description'));
        summary.put('folderId', meta.get('folderId'));
        putIfSet(summary, 'format', meta.get('reportFormat'));
        putIfSet(summary, 'reportType', type == null ? null : type.get('type'));
        putIfSet(summary, 'url', reportUrl(baseUrl, id));
        List<Object> columns = new List<Object>();
        for (String name : (List<String>) meta.get('detailColumns')) {
            Map<String, Object> c = new Map<String, Object>{ 'name' => name, 'label' => columnLabel(name, maps) };
            putIfSet(c, 'dataType', maps.detail.containsKey(name) ? maps.detail.get(name).get('dataType') : null);
            columns.add(c);
        }
        summary.put('columns', columns);
        summary.put('groupingsDown', summarizeGroupings((List<Object>) meta.get('groupingsDown'), maps));
        summary.put('groupingsAcross', summarizeGroupings((List<Object>) meta.get('groupingsAcross'), maps));
        List<Object> aggregates = new List<Object>();
        for (String name : (List<String>) meta.get('aggregates')) {
            String label = maps.aggregate.containsKey(name) ? maps.aggregate.get(name).get('label') : null;
            aggregates.add(new Map<String, Object>{ 'name' => name, 'label' => label != null ? label : humanize(name) });
        }
        summary.put('aggregates', aggregates);
        summary.put('filters', describeFilters(meta, maps));
        if (includeMetadata == true) summary.put('reportMetadata', meta);
        return summary;
    }

    static List<Object> summarizeGroupings(List<Object> groupings, InfoMaps maps) {
        List<Object> out = new List<Object>();
        for (Object o : groupings) {
            Map<String, Object> g = (Map<String, Object>) o;
            Map<String, Object> s = new Map<String, Object>{ 'name' => g.get('name'), 'label' => columnLabel((String) g.get('name'), maps) };
            putIfSet(s, 'sortOrder', g.get('sortOrder'));
            putIfSet(s, 'dateGranularity', g.get('dateGranularity'));
            out.add(s);
        }
        return out;
    }

    /** describe_report_type's summary, from the report type metadata of a saved report of that type. */
    public static Map<String, Object> summarizeReportType(Reports.ReportTypeMetadata tm, String label, String type, String search, Integer lim) {
        String needle = search == null ? null : search.toLowerCase().trim();
        Integer max = lim == null ? 150 : lim;
        List<Object> sections = new List<Object>();
        Integer fieldCount = 0;
        Integer shown = 0;
        List<Object> dateColumns = new List<Object>();
        for (Reports.ReportTypeColumnCategory cat : tm.getCategories()) {
            List<Object> fields = new List<Object>();
            Map<String, Reports.ReportTypeColumn> cols = cat.getColumns();
            for (String name : cols.keySet()) {
                Reports.ReportTypeColumn col = cols.get(name);
                String dt = dataType(col.getDataType());
                fieldCount++;
                if (dt == 'date' || dt == 'datetime') dateColumns.add(new Map<String, Object>{ 'name' => name, 'label' => col.getLabel() });
                Boolean match = String.isEmpty(needle)
                    || name.toLowerCase().contains(needle)
                    || String.valueOf(col.getLabel()).toLowerCase().contains(needle)
                    || String.valueOf(cat.getLabel()).toLowerCase().contains(needle);
                if (match && shown < max) {
                    fields.add(new Map<String, Object>{ 'name' => name, 'label' => col.getLabel(), 'dataType' => dt });
                    shown++;
                }
            }
            if (!fields.isEmpty()) sections.add(new Map<String, Object>{ 'section' => cat.getLabel(), 'fields' => fields });
        }
        List<String> durations = new List<String>();
        if (tm.getStandardDateFilterDurationGroups() != null) {
            for (Reports.StandardDateFilterDurationGroup g : tm.getStandardDateFilterDurationGroups()) {
                for (Reports.StandardDateFilterDuration d : g.getStandardDateFilterDurations()) durations.add(d.getValue());
            }
        }
        List<String> scopes = new List<String>();
        if (tm.getScopeInfo() != null) {
            // Apex has no public ScopeValue type, so read the values through their JSON form.
            Map<String, Object> scopeInfo = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(tm.getScopeInfo()));
            for (Object s : (List<Object>) scopeInfo.get('values')) scopes.add((String) ((Map<String, Object>) s).get('value'));
        }
        Map<String, Object> out = new Map<String, Object>{
            'type' => type,
            'fieldCount' => fieldCount,
            'fieldsShown' => shown,
            'sections' => sections,
            'dateFilterColumns' => dateColumns,
            'dateFilterDurations' => durations,
            'dateGranularities' => DATE_GRANULARITY_INFOS,
            'filterOperators' => new Map<String, Object>(),
            'scopes' => scopes
        };
        putIfSet(out, 'label', label);
        return out;
    }

    static void putIfSet(Map<String, Object> m, String key, Object value) {
        if (value != null) m.put(key, value);
    }
}
