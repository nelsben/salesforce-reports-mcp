/**
 * Core layer: the three dashboard readers, list_dashboards, describe_dashboard and run_dashboard, ported from
 * src/reports/dashboards.ts and the dashboard tools in src/server.ts (docs/decisions/0016 to 0018). Apex has no
 * dashboard API, so describe, run and each listed dashboard's last refresh go through ReportsCallout to
 * /analytics/dashboards, as an unsaved report run does. The list itself is SOQL on Dashboard in user mode. Each
 * component's reportResult is an ordinary report run, so ReportsShape.shapeJson shapes it. Filters go on the GET's
 * query string as filter<n>=<optionId>, never in a body. refresh_dashboard stays on the local server. Every failure
 * leaves as a ReportsException; the class knows nothing of HTTP.
 */
public with sharing class ReportsDashboards {
    /** Default cap on detail rows per component. */
    public static final Integer COMPONENT_ROWS = 20;
    public static final Integer DEFAULT_LIMIT = 25;
    public static final Integer MAX_LIMIT = 50;
    static final Long DAY_MS = 24L * 60 * 60 * 1000;
    static final Map<String, String> AGGREGATE_WORDS = new Map<String, String>{ 's' => 'Sum of', 'a' => 'Average of', 'm' => 'Smallest', 'mx' => 'Largest', 'u' => 'Unique' };
    /** A Salesforce date such as 2026-10-17T02:13:35.000+0000, or an ISO 8601 one. */
    static final Pattern STAMP = Pattern.compile('(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,3})\\d*)?(Z|[+-]\\d{2}:?\\d{2})?');

    /** Tests set this to fix "now" for the age note. */
    @TestVisible
    static Datetime clock;

    // ---- list_dashboards ----

    /**
     * SOQL on Dashboard, as GET /analytics/dashboards lists only recently viewed ones. One row past the limit tells
     * whether the list was cut. The last refresh comes from one /status call per row, since the SOQL field
     * DashboardResultRefreshedDate stays null after a REST refresh.
     */
    public static Map<String, Object> listDashboards(Map<String, Object> input) {
        String query = ReportsInput.optString(input, 'query');
        String folder = ReportsInput.optString(input, 'folder');
        Integer lim = ReportsInput.optInt(input, 'limit', 1, MAX_LIMIT);
        Integer cap = lim == null ? DEFAULT_LIMIT : lim;
        List<String> conditions = new List<String>();
        if (String.isNotEmpty(query)) {
            conditions.add('(Title LIKE \'%' + ReportsService.soqlLike(query) + '%\' OR DeveloperName LIKE \'%' + ReportsService.soqlLike(query) + '%\')');
        }
        if (String.isNotEmpty(folder)) conditions.add('FolderName LIKE \'%' + ReportsService.soqlLike(folder) + '%\'');
        String soql = 'SELECT Id, Title, DeveloperName, FolderName, FolderId, Description, Type, LastModifiedDate FROM Dashboard'
            + (conditions.isEmpty() ? '' : ' WHERE ' + String.join(conditions, ' AND '))
            + ' ORDER BY LastModifiedDate DESC LIMIT ' + (cap + 1);
        return listRows((List<Dashboard>) Database.query(soql, AccessLevel.USER_MODE), cap);
    }

    /**
     * The list answer for these rows. A failed /status call gives lastRefreshed null, as on the local server. After a
     * CALLOUT_* error the door cannot call out under this sign-in at all, so it stops asking for the rest of the list.
     */
    @TestVisible
    static Map<String, Object> listRows(List<Dashboard> rows, Integer cap) {
        String base = ReportsService.baseUrl();
        List<Object> dashboards = new List<Object>();
        Boolean noData = false;
        String stoppedBy;
        for (Integer i = 0; i < Math.min(rows.size(), cap); i++) {
            Dashboard r = rows[i];
            String refreshed;
            if (stoppedBy == null) {
                try {
                    refreshed = latestRefresh(ReportsCallout.send('GET', path(r.Id) + '/status', null));
                } catch (ReportsException e) {
                    if (e.code != null && e.code.startsWith('CALLOUT_')) stoppedBy = e.code;
                } catch (Exception e) {
                    // as on the local server: a failed status call gives null
                }
                if (stoppedBy == null && refreshed == null) noData = true;
            }
            dashboards.add(new Map<String, Object>{
                'id' => r.Id,
                'title' => r.Title,
                'developerName' => r.DeveloperName,
                'folder' => r.FolderName,
                'folderId' => r.FolderId,
                'description' => r.Description,
                'runsAs' => r.Type,
                'lastRefreshed' => refreshed,
                'lastModifiedDate' => ReportsService.soqlDatetime(r.LastModifiedDate),
                'url' => dashboardUrl(base, r.Id)
            });
        }
        List<String> notes = new List<String>();
        if (rows.size() > cap) notes.add('Showing the first ' + cap + ' matches; more dashboards match. Narrow query or folder, or raise limit (up to ' + MAX_LIMIT + ').');
        if (noData) notes.add('lastRefreshed is null for a dashboard with no data yet: run_dashboard will say so, and refresh_dashboard fills it.');
        if (stoppedBy != null) {
            notes.add('The in-org door could not call the org\'s REST API under this sign-in (' + stoppedBy + '), so lastRefreshed is null for the dashboards it could not read. Use the local server for refresh dates.');
        }
        return new Map<String, Object>{ 'count' => dashboards.size(), 'dashboards' => dashboards, 'notes' => notes };
    }

    /** The newest refresh date in a status answer, or null when no component was ever refreshed. */
    @TestVisible
    static String latestRefresh(Object status) {
        String latest;
        Long latestTime;
        for (Object o : items(jsonMap(status).get('componentStatus'))) {
            String d = str(jsonMap(o).get('refreshDate'));
            if (String.isEmpty(d)) continue;
            Long t = timeOf(d);
            if (latest == null) {
                latest = d;
                latestTime = t;
            } else if (t != null && latestTime != null && t > latestTime) {
                latest = d;
                latestTime = t;
            }
        }
        return latest;
    }

    // ---- describe_dashboard ----

    public static Map<String, Object> describeDashboard(Map<String, Object> input) {
        String id = ReportsInput.dashboardId(input, 'dashboardId');
        Map<String, Object> described = ReportsInput.asMap(ReportsCallout.send('GET', path(id) + '/describe', null), 'The dashboard describe');
        return summarize(described, ReportsService.baseUrl(), reportNames(described));
    }

    /** src/reports/dashboards.ts summarizeDashboard. */
    @TestVisible
    static Map<String, Object> summarize(Map<String, Object> d, String base, Map<String, String> names) {
        List<Object> filters = new List<Object>();
        for (Object o : items(d.get('filters'))) {
            Map<String, Object> f = jsonMap(o);
            filters.add(new Map<String, Object>{ 'name' => f.get('name'), 'dataType' => f.get('dataType'), 'options' => optionLabels(items(f.get('options'))) });
        }
        List<Object> components = new List<Object>();
        for (Placed p : inLayoutOrder(d)) {
            Map<String, Object> c = p.component;
            Map<String, Object> props = jsonMap(c.get('properties'));
            String reportId = str(c.get('reportId'));
            Map<String, Object> report = new Map<String, Object>{ 'id' => reportId, 'name' => nameOf(names, reportId) };
            putIfSet(report, 'url', ReportsSummary.reportUrl(base, reportId));
            List<Object> groupings = new List<Object>();
            for (Object g : items(props.get('groupings'))) groupings.add(jsonMap(g).get('name'));
            List<Object> measures = new List<Object>();
            for (Object a : items(props.get('aggregates'))) {
                String name = str(jsonMap(a).get('name'));
                measures.add(new Map<String, Object>{ 'name' => name, 'label' => measureLabel(name) });
            }
            components.add(new Map<String, Object>{
                'id' => c.get('id'),
                'header' => c.get('header'),
                'title' => c.get('title'),
                'footer' => c.get('footer'),
                'visualizationType' => props.get('visualizationType'),
                'report' => report,
                'groupings' => groupings,
                'measures' => measures,
                'position' => p.position
            });
        }
        Object numColumns = jsonMap(d.get('layout')).get('numColumns');
        Map<String, Object> out = new Map<String, Object>{
            'id' => d.get('id'),
            'name' => d.get('name'),
            'developerName' => d.get('developerName'),
            'description' => d.get('description'),
            'folder' => new Map<String, Object>{ 'id' => d.get('folderId'), 'name' => d.get('folderName') },
            'type' => d.get('dashboardType'),
            'runningUser' => runningUserWords(d),
            'owner' => jsonMap(d.get('owner')).get('displayName')
        };
        putIfSet(out, 'url', dashboardUrl(base, str(d.get('id'))));
        out.put('filters', filters);
        out.put('layout', 'Components are listed in layout order: top to bottom, then left to right, on a grid ' + (numColumns == null ? '12' : str(numColumns)) + ' columns wide.');
        out.put('components', components);
        return out;
    }

    /** The names of a dashboard's source reports, by 18- and 15-character id. Empty when the lookup fails. */
    static Map<String, String> reportNames(Map<String, Object> d) {
        Set<String> ids = new Set<String>();
        for (Object o : items(d.get('components'))) {
            String id = str(jsonMap(o).get('reportId'));
            if (String.isNotEmpty(id)) ids.add(id);
        }
        Map<String, String> names = new Map<String, String>();
        if (ids.isEmpty()) return names;
        try {
            for (Report r : [SELECT Id, Name FROM Report WHERE Id IN :ids WITH USER_MODE]) {
                names.put(String.valueOf(r.Id), r.Name);
                names.put(String.valueOf(r.Id).left(15), r.Name);
            }
        } catch (Exception e) {
            // names stay null: the ids still work with run_report
        }
        return names;
    }

    static String nameOf(Map<String, String> names, String id) {
        if (String.isEmpty(id)) return null;
        if (names.containsKey(id)) return names.get(id);
        return names.get(id.left(15));
    }

    static String measureLabel(String name) {
        if (isText(name, 'RowCount')) return 'Record Count';
        Matcher m = Pattern.compile('^([a-z]+)!').matcher(name == null ? '' : name);
        String words = m.find() ? AGGREGATE_WORDS.get(m.group(1)) : null;
        return words != null ? words + ' ' + ReportsSummary.humanize(name) : ReportsSummary.humanize(name == null ? '' : name);
    }

    // ---- run_dashboard ----

    /**
     * The cached results, never a refresh. Filters given by name and label are checked against describe before the
     * data call, so a bad label costs one describe and no data call.
     */
    public static Map<String, Object> runDashboard(Map<String, Object> input) {
        String id = ReportsInput.dashboardId(input, 'dashboardId');
        List<Choice> choices = choices(input);
        Integer maxRows = ReportsInput.optInt(input, 'maxRows', 1, ReportsShape.HARD_ROW_CEILING);
        Resolved resolved;
        if (!choices.isEmpty()) {
            resolved = resolveFilters(ReportsInput.asMap(ReportsCallout.send('GET', path(id) + '/describe', null), 'The dashboard describe'), choices);
        }
        Object answer = ReportsCallout.send('GET', path(id) + (resolved == null ? '' : resolved.query), null);
        ReportsShape.guardHeap();
        Map<String, Object> raw = ReportsInput.asMap(answer, 'The dashboard results');
        if (resolved == null) resolved = resolveFilters(jsonMap(raw.get('dashboardMetadata')), new List<Choice>());
        Integer cap = Math.min(maxRows == null ? COMPONENT_ROWS : maxRows, ReportsShape.HARD_ROW_CEILING);
        return shape(raw, ReportsService.baseUrl(), cap, resolved, clock != null ? clock : Datetime.now());
    }

    /**
     * src/reports/dashboards.ts shapeDashboard, with what src/server.ts dashboardView adds for the dashboard card:
     * each component's sourceReport, measure, metricLabel, gauge and colorPalette, and the dashboard's colorPalette.
     * Components are joined to their data by component id, never by index.
     */
    @TestVisible
    static Map<String, Object> shape(Map<String, Object> raw, String base, Integer maxRows, Resolved filters, Datetime now) {
        Map<String, Object> meta = jsonMap(raw.get('dashboardMetadata'));
        Map<String, Object> attributes = jsonMap(raw.get('attributes'));
        Map<String, Map<String, Object>> data = new Map<String, Map<String, Object>>();
        for (Object o : items(raw.get('componentData'))) {
            Map<String, Object> entry = jsonMap(o);
            data.put(str(entry.get('componentId')), entry);
        }
        List<Object> components = new List<Object>();
        List<Map<String, Object>> withData = new List<Map<String, Object>>();
        List<Map<String, Object>> noData = new List<Map<String, Object>>();
        List<Map<String, Object>> failed = new List<Map<String, Object>>();
        for (Placed p : inLayoutOrder(meta)) {
            Map<String, Object> c = p.component;
            Map<String, Object> entry = data.get(str(c.get('id')));
            Map<String, Object> status = entry == null ? new Map<String, Object>() : jsonMap(entry.get('status'));
            Map<String, Object> props = jsonMap(c.get('properties'));
            Map<String, Object> visual = jsonMap(props.get('visualizationProperties'));
            String state = componentStatus(entry);
            Map<String, Object> out = new Map<String, Object>{
                'id' => c.get('id'),
                'header' => c.get('header'),
                'title' => c.get('title'),
                'footer' => c.get('footer'),
                'visualizationType' => props.get('visualizationType'),
                'status' => state,
                'refreshedAt' => status.get('refreshDate')
            };
            Map<String, Object> reportResult = entry == null ? new Map<String, Object>() : jsonMap(entry.get('reportResult'));
            Map<String, Object> result;
            if (state == 'error') {
                Object code = status.get('errorCode') != null ? status.get('errorCode') : status.get('componentDataStatus');
                Object message = status.get('errorMessage');
                out.put('error', new Map<String, Object>{ 'code' => code == null ? 'UNKNOWN' : str(code), 'message' => message == null ? 'Salesforce gave no message.' : str(message) });
                failed.add(out);
            } else if (state == 'data') {
                Boolean tabular = isText(jsonMap(reportResult.get('reportMetadata')).get('reportFormat'), 'TABULAR');
                result = ReportsShape.shapeJson(reportResult, maxRows, tabular, base, new List<String>());
                // reportMetadata shows the source report's own filters, never the dashboard's.
                if (!items(props.get('filterColumns')).isEmpty()) {
                    List<String> lines = (List<String>) result.get('filters');
                    for (String w : filters.applied) lines.add('Dashboard filter ' + w);
                }
                out.put('result', result);
                withData.add(out);
            } else {
                noData.add(out);
            }

            // What the dashboard card draws with (src/server.ts dashboardView).
            String reportId = str(c.get('reportId'));
            if (reportId == null && result != null) reportId = str(jsonMap(result.get('report')).get('id'));
            Map<String, Object> source = new Map<String, Object>{ 'id' => reportId };
            putIfSet(source, 'url', ReportsSummary.reportUrl(base, reportId));
            out.put('sourceReport', source);
            List<Object> aggregates = items(props.get('aggregates'));
            Object first = aggregates.isEmpty() ? null : jsonMap(aggregates[0]).get('name');
            String name = first instanceof String && String.isNotEmpty((String) first) ? (String) first : null;
            if (name == null) {
                out.put('measure', null);
            } else {
                Map<String, Object> info = jsonMap(jsonMap(jsonMap(reportResult.get('reportExtendedMetadata')).get('aggregateColumnInfo')).get(name));
                Object label = info.get('label') != null ? info.get('label') : (isText(name, 'RowCount') ? 'Record Count' : name);
                Object dataType = info.get('dataType') != null ? info.get('dataType') : (isText(name, 'RowCount') ? 'int' : 'number');
                out.put('measure', new Map<String, Object>{ 'name' => name, 'label' => label, 'dataType' => dataType });
            }
            if (isNonEmptyText(visual.get('metricLabel'))) out.put('metricLabel', visual.get('metricLabel'));
            if (isNonEmptyText(visual.get('colorPalette'))) out.put('colorPalette', visual.get('colorPalette'));
            if (isText(out.get('visualizationType'), 'Gauge')) {
                Map<String, Object> gauge = gauge(visual);
                if (gauge != null) out.put('gauge', gauge);
            }
            components.add(out);
        }

        List<String> notes = new List<String>();
        String forWhat = filters.applied.isEmpty() ? '' : ' for ' + String.join(filters.applied, ', ');
        if (!components.isEmpty() && noData.size() == components.size()) {
            notes.add('No component has data' + forWhat + ': the dashboard has not been refreshed' + (forWhat == '' ? '' : ' with these filters')
                + '. Call refresh_dashboard with the same filters to get numbers.');
        } else if (!noData.isEmpty()) {
            List<String> labels = new List<String>();
            for (Map<String, Object> c : noData) labels.add(label(c));
            notes.add(noData.size() + ' of ' + components.size() + ' components have no data' + forWhat + ' (' + String.join(labels, ', ')
                + '). Call refresh_dashboard with the same filters to fill them.');
        }
        for (Map<String, Object> c : failed) {
            Map<String, Object> error = (Map<String, Object>) c.get('error');
            notes.add(label(c) + ' failed in Salesforce: ' + error.get('code') + ': ' + error.get('message'));
        }

        String refreshedAt;
        Long refreshedTime;
        Boolean stale = false;
        for (Map<String, Object> c : withData) {
            String d = str(c.get('refreshedAt'));
            if (String.isNotEmpty(d)) {
                Long t = timeOf(d);
                if (refreshedAt == null) {
                    refreshedAt = d;
                    refreshedTime = t;
                } else if (t != null && refreshedTime != null && t < refreshedTime) {
                    refreshedAt = d;
                    refreshedTime = t;
                }
            }
            if (isText(jsonMap(data.get(str(c.get('id'))).get('status')).get('refreshStatus'), 'STALE')) stale = true;
        }
        if (refreshedAt != null && stale) {
            notes.add('Salesforce marks this data stale: the dashboard was refreshed since with other filters. These numbers are from ' + refreshedAt
                + '; call refresh_dashboard with the same filters for current ones.');
        }
        if (refreshedAt != null && refreshedTime != null) {
            Long age = now.getTime() - refreshedTime;
            if (age > DAY_MS) {
                Long days = age / DAY_MS;
                notes.add('These numbers were refreshed ' + days + ' day' + (days == 1 ? '' : 's') + ' ago, at ' + refreshedAt + '. Call refresh_dashboard for current ones.');
            }
        }
        for (Map<String, Object> c : withData) {
            for (String n : (List<String>) ((Map<String, Object>) c.get('result')).get('notes')) notes.add(label(c) + ': ' + n);
        }

        Object id = meta.get('id') != null ? meta.get('id') : attributes.get('dashboardId');
        Object name = meta.get('name') != null ? meta.get('name') : (attributes.get('dashboardName') != null ? attributes.get('dashboardName') : 'Dashboard');
        Map<String, Object> dashboard = new Map<String, Object>{
            'id' => id,
            'name' => name,
            'developerName' => meta.get('developerName'),
            'folder' => new Map<String, Object>{ 'id' => meta.get('folderId'), 'name' => meta.get('folderName') }
        };
        putIfSet(dashboard, 'url', dashboardUrl(base, str(id)));
        Map<String, Object> out = new Map<String, Object>{
            'dashboard' => dashboard,
            'runningUser' => runningUserWords(meta),
            'filters' => filters.words,
            'refreshedAt' => refreshedAt,
            'components' => components,
            'notes' => notes
        };
        if (isNonEmptyText(meta.get('colorPalette'))) out.put('colorPalette', meta.get('colorPalette'));
        return out;
    }

    /** "data", "no data" or "error", as src/reports/dashboards.ts componentStatus reads a component's entry. */
    static String componentStatus(Map<String, Object> entry) {
        Map<String, Object> status = entry == null ? new Map<String, Object>() : jsonMap(entry.get('status'));
        Object dataStatus = status.get('componentDataStatus');
        if (truthy(status.get('errorCode')) || isText(dataStatus, 'ERROR')) return 'error';
        if (entry != null && entry.get('reportResult') != null) return 'data';
        if (entry == null || isText(dataStatus, 'NO_DATA') || isText(dataStatus, 'DATA')) return 'no data';
        return 'error';
    }

    /**
     * A gauge's range, the breakpoints between its bands and each band's colour (empty unless every band has one),
     * or null when the bands have fewer than two bounds.
     */
    static Map<String, Object> gauge(Map<String, Object> visual) {
        List<Object> points = items(visual.get('breakPoints'));
        List<Object> breaks = points.isEmpty() ? new List<Object>() : items(jsonMap(points[0]).get('breaks'));
        Object min;
        Object max;
        Integer bounds = 0;
        for (Object b : breaks) {
            for (String key : new List<String>{ 'lowerBound', 'upperBound' }) {
                Object v = jsonMap(b).get(key);
                if (!isNumber(v)) continue;
                bounds++;
                if (min == null || num(v) < num(min)) min = v;
                if (max == null || num(v) > num(max)) max = v;
            }
        }
        if (bounds < 2 || !(num(max) > num(min))) return null;
        List<Object> middle = new List<Object>();
        for (Integer i = 1; i < breaks.size(); i++) {
            Object lower = jsonMap(breaks[i]).get('lowerBound');
            if (isNumber(lower) && num(lower) > num(min) && num(lower) < num(max)) middle.add(lower);
        }
        List<Object> colors = new List<Object>();
        for (Object b : breaks) {
            Object color = jsonMap(b).get('color');
            if (color instanceof String && Pattern.matches('[0-9a-fA-F]{6}', (String) color)) colors.add('#' + ((String) color).toLowerCase());
        }
        return new Map<String, Object>{ 'min' => min, 'max' => max, 'breakpoints' => middle, 'colors' => colors.size() == middle.size() + 1 ? colors : new List<Object>() };
    }

    static String label(Map<String, Object> component) {
        if (component.get('header') != null) return str(component.get('header'));
        if (component.get('title') != null) return str(component.get('title'));
        return str(component.get('id'));
    }

    // ---- filters ----

    /** One filter choice: a dashboard filter's name and one of its option labels, values, aliases or ids. */
    public class Choice {
        public String name;
        public String option;
    }

    /** Filters resolved against describe: the query string, every filter in words, and the ones set. */
    public class Resolved {
        public String query = '';
        public List<String> words = new List<String>();
        public List<String> applied = new List<String>();
    }

    /** The `filters` input: at most three {name, option} choices, each with both set. */
    static List<Choice> choices(Map<String, Object> input) {
        List<Object> given = ReportsInput.optList(input, 'filters');
        List<Choice> out = new List<Choice>();
        if (given == null) return out;
        if (given.size() > 3) throw ReportsException.invalidInput('filters takes at most 3 choices, one option per filter.');
        for (Object o : given) {
            Map<String, Object> m = ReportsInput.asMap(o, 'Each filter');
            Choice c = new Choice();
            c.name = ReportsInput.reqString(m, 'name');
            c.option = ReportsInput.reqString(m, 'option');
            if (String.isEmpty(c.name) || String.isEmpty(c.option)) throw ReportsException.invalidInput('Each filter needs a name and an option.');
            out.add(c);
        }
        return out;
    }

    /**
     * src/reports/dashboards.ts resolveFilters: choices by name and option label, mapped to the option ids the data
     * call takes as filter<n>, n being the filter's place in describe's filters. The option text is never sent.
     */
    @TestVisible
    static Resolved resolveFilters(Map<String, Object> meta, List<Choice> choices) {
        List<Object> filters = items(meta.get('filters'));
        Resolved r = new Resolved();
        if (choices.isEmpty()) {
            for (Object f : filters) r.words.add(allWords(jsonMap(f)));
            return r;
        }
        if (filters.isEmpty()) throw ReportsException.invalidInput('This dashboard has no filters. Leave out `filters`.');
        Map<Integer, Map<String, Object>> chosen = new Map<Integer, Map<String, Object>>();
        for (Choice choice : choices) {
            Integer index = -1;
            for (Integer i = 0; i < filters.size(); i++) {
                if (same(jsonMap(filters[i]).get('name'), choice.name)) {
                    index = i;
                    break;
                }
            }
            if (index < 0) throw ReportsException.invalidInput('No dashboard filter named "' + choice.name + '". This dashboard\'s filters: ' + listing(filters) + '.');
            Map<String, Object> filter = jsonMap(filters[index]);
            if (chosen.containsKey(index)) throw ReportsException.invalidInput('The filter ' + str(filter.get('name')) + ' is given twice. Give one option per filter.');
            List<Object> options = items(filter.get('options'));
            Map<String, Object> option;
            for (Object o : options) {
                Map<String, Object> m = jsonMap(o);
                Object optionId = m.get('id');
                // An id matches exactly; a label, value or alias ignoring case and outer spaces.
                if ((optionId instanceof String && ((String) optionId).equals(choice.option))
                    || same(optionLabel(m), choice.option) || same(m.get('value'), choice.option) || same(m.get('alias'), choice.option)) {
                    option = m;
                    break;
                }
            }
            if (option == null) {
                throw ReportsException.invalidInput(str(filter.get('name')) + ' has no option "' + choice.option + '". Its options: ' + String.join(optionLabels(options), ', ') + '.');
            }
            chosen.put(index, option);
        }
        List<Integer> places = new List<Integer>(chosen.keySet());
        places.sort();
        List<String> parts = new List<String>();
        for (Integer i : places) parts.add('filter' + (i + 1) + '=' + ReportsCallout.segment(str(chosen.get(i).get('id'))));
        r.query = '?' + String.join(parts, '&');
        for (Integer i = 0; i < filters.size(); i++) {
            Map<String, Object> f = jsonMap(filters[i]);
            if (chosen.containsKey(i)) {
                String w = str(f.get('name')) + ': ' + optionLabel(chosen.get(i));
                r.words.add(w);
                r.applied.add(w);
            } else {
                r.words.add(allWords(f));
            }
        }
        return r;
    }

    static String allWords(Map<String, Object> filter) {
        return str(filter.get('name')) + ': all (no option chosen)';
    }

    static String listing(List<Object> filters) {
        List<String> parts = new List<String>();
        for (Object o : filters) {
            Map<String, Object> f = jsonMap(o);
            parts.add(str(f.get('name')) + ' (' + String.join(optionLabels(items(f.get('options'))), ', ') + ')');
        }
        return String.join(parts, '; ');
    }

    static List<String> optionLabels(List<Object> options) {
        List<String> out = new List<String>();
        for (Object o : options) out.add(optionLabel(jsonMap(o)));
        return out;
    }

    /** An option's label: its alias, else its value, else its range, else its id. */
    @TestVisible
    static String optionLabel(Map<String, Object> option) {
        if (truthy(option.get('alias'))) return str(option.get('alias'));
        Object value = option.get('value');
        if (value != null && !(value instanceof String && ((String) value).length() == 0)) return str(value);
        Object startValue = option.get('startValue');
        Object endValue = option.get('endValue');
        if (truthy(startValue) && truthy(endValue)) return str(startValue) + ' to ' + str(endValue);
        if (truthy(startValue)) return str(startValue) + ' or more';
        if (truthy(endValue)) return 'up to ' + str(endValue);
        return str(option.get('id'));
    }

    /** Whose data the dashboard shows, in words. */
    @TestVisible
    static String runningUserWords(Map<String, Object> meta) {
        String name = str(jsonMap(meta.get('runningUser')).get('displayName'));
        Object type = meta.get('dashboardType');
        if (isText(type, 'SpecifiedUser')) return (name != null ? name : 'A set user') + ': the dashboard always runs as this user, so every viewer sees the same data.';
        if (isText(type, 'LoggedInUser')) return 'The viewer: each person sees the data they can see, so these results are the signed-in user\'s.';
        if (isText(type, 'MyTeamUser')) return 'The viewer, who as a manager can also view it as someone on their team. These results are the signed-in user\'s.';
        return String.isNotEmpty(name) ? name + ' (' + (type != null ? str(type) : 'unknown type') + ')' : 'Unknown';
    }

    // ---- layout ----

    /** A component with its grid cell, sorted top to bottom, then left to right, then in describe's order. */
    class Placed implements Comparable {
        Map<String, Object> component;
        Map<String, Object> position;
        Decimal row;
        Decimal column;
        Integer index;

        public Integer compareTo(Object other) {
            Placed b = (Placed) other;
            if (position == null || b.position == null) return index - b.index;
            Integer byRow = compare(row, b.row);
            if (byRow != 0) return byRow;
            Integer byColumn = compare(column, b.column);
            return byColumn != 0 ? byColumn : index - b.index;
        }
    }

    static Integer compare(Decimal a, Decimal b) {
        if (a == null || b == null || a == b) return 0;
        return a < b ? -1 : 1;
    }

    /** describe's components in layout order, each with its grid position: {row, column, rows, columns}, or null. */
    static List<Placed> inLayoutOrder(Map<String, Object> meta) {
        List<Object> components = items(meta.get('components'));
        List<Object> cells = items(jsonMap(meta.get('layout')).get('components'));
        List<Placed> placed = new List<Placed>();
        for (Integer i = 0; i < components.size(); i++) {
            Placed p = new Placed();
            p.component = jsonMap(components[i]);
            p.index = i;
            Object cell = i < cells.size() ? cells[i] : null;
            if (cell instanceof Map<String, Object>) {
                Map<String, Object> c = (Map<String, Object>) cell;
                p.position = new Map<String, Object>();
                copy(p.position, 'row', c, 'row');
                copy(p.position, 'column', c, 'column');
                copy(p.position, 'rows', c, 'rowspan');
                copy(p.position, 'columns', c, 'colspan');
                p.row = num(c.get('row'));
                p.column = num(c.get('column'));
            }
            placed.add(p);
        }
        placed.sort();
        return placed;
    }

    // ---- helpers ----

    static String path(String id) {
        return '/analytics/dashboards/' + ReportsCallout.segment(id);
    }

    public static String dashboardUrl(String base, String id) {
        return String.isNotEmpty(base) && String.isNotEmpty(id) ? base + '/lightning/r/Dashboard/' + id + '/view' : null;
    }

    /** Milliseconds since 1970 for a Salesforce date (2026-10-17T02:13:35.000+0000) or ISO 8601 one, or null. */
    @TestVisible
    static Long timeOf(String value) {
        if (value == null) return null;
        Matcher m = STAMP.matcher(value);
        if (!m.matches()) return null;
        Long ms = Datetime.newInstanceGmt(Integer.valueOf(m.group(1)), Integer.valueOf(m.group(2)), Integer.valueOf(m.group(3)),
            Integer.valueOf(m.group(4)), Integer.valueOf(m.group(5)), Integer.valueOf(m.group(6))).getTime();
        if (m.group(7) != null) ms += Integer.valueOf(m.group(7).rightPad(3, '0'));
        String zone = m.group(8);
        if (zone != null && zone != 'Z') {
            String z = zone.remove(':');
            Integer minutes = Integer.valueOf(z.substring(1, 3)) * 60 + Integer.valueOf(z.substring(3, 5));
            ms -= (z.startsWith('-') ? -1 : 1) * minutes * 60000L;
        }
        return ms;
    }

    /** Both strings, equal ignoring case and outer spaces. */
    static Boolean same(Object a, Object b) {
        return a instanceof String && b instanceof String && ((String) a).trim().toLowerCase().equals(((String) b).trim().toLowerCase());
    }

    /** JavaScript's truthiness for a JSON value. */
    static Boolean truthy(Object value) {
        if (value == null) return false;
        if (value instanceof Boolean) return (Boolean) value;
        if (value instanceof String) return ((String) value).length() > 0;
        if (isNumber(value)) return num(value) != 0;
        return true;
    }

    /** Exactly this text, with case: Apex's == on strings ignores case. */
    static Boolean isText(Object value, String text) {
        return value instanceof String && ((String) value).equals(text);
    }

    static Boolean isNonEmptyText(Object value) {
        return value instanceof String && ((String) value).length() > 0;
    }

    static Boolean isNumber(Object value) {
        return value instanceof Integer || value instanceof Long || value instanceof Decimal || value instanceof Double;
    }

    static Decimal num(Object value) {
        if (value instanceof Integer) return (Integer) value;
        if (value instanceof Long) return (Long) value;
        if (value instanceof Decimal) return (Decimal) value;
        if (value instanceof Double) return Decimal.valueOf((Double) value);
        return null;
    }

    /** Copies a key only when the source has it, as a JavaScript object literal leaves an undefined value out. */
    static void copy(Map<String, Object> target, String targetKey, Map<String, Object> source, String sourceKey) {
        if (source.containsKey(sourceKey)) target.put(targetKey, source.get(sourceKey));
    }

    static void putIfSet(Map<String, Object> target, String key, Object value) {
        if (value != null) target.put(key, value);
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
}
