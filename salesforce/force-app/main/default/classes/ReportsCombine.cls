/**
 * Core layer: stack and join of ReportResults, ported from src/reports/combine.ts. Results are the maps ReportsShape
 * builds. A CombineException is bad input, and ReportsException.fromException says so.
 */
public with sharing class ReportsCombine {
    public class CombineException extends Exception {}

    public static Map<String, Object> combineResults(String mode, List<String> aliases, List<Map<String, Object>> results, List<String> joinOn) {
        if (aliases.size() < 2 || aliases.size() > 5) throw new CombineException('combine_reports takes 2 to 5 inputs.');
        if (new Set<String>(aliases).size() != aliases.size()) throw new CombineException('Each input needs its own alias.');
        List<Object> filters = new List<Object>();
        List<Object> notes = new List<Object>();
        for (Integer i = 0; i < aliases.size(); i++) {
            for (Object f : (List<Object>) results[i].get('filters')) filters.add(aliases[i] + ': ' + f);
            for (Object n : (List<Object>) results[i].get('notes')) notes.add(aliases[i] + ': ' + n);
        }
        Map<String, Object> out = new Map<String, Object>{
            'report' => new Map<String, Object>{
                'id' => null,
                'name' => 'combined: ' + String.join(aliases, ', '),
                'format' => mode == 'join' ? 'SUMMARY' : 'TABULAR',
                'reportType' => 'combined'
            },
            'filters' => filters,
            'notes' => notes
        };
        out.putAll(mode == 'join' ? join(aliases, results, joinOn) : stack(aliases, results));
        return out;
    }

    static Map<String, Object> stack(List<String> aliases, List<Map<String, Object>> results) {
        Boolean allGroups = true;
        Boolean allDetail = true;
        for (Map<String, Object> r : results) {
            allGroups = allGroups && r.get('groups') != null;
            allDetail = allDetail && r.get('detail') != null;
        }
        if (allGroups) {
            List<Object> allDims = new List<Object>();
            List<Object> allMeasures = new List<Object>();
            for (Map<String, Object> r : results) {
                allDims.addAll(items(group(r).get('dimensions')));
                allMeasures.addAll(items(group(r).get('measures')));
            }
            List<Object> dims = unionByName(allDims);
            List<Object> measures = unionByName(allMeasures);
            List<Object> rows = new List<Object>();
            for (Integer i = 0; i < results.size(); i++) {
                Map<String, Object> g = group(results[i]);
                List<String> dimIdx = namesOf(items(g.get('dimensions')));
                List<String> measureIdx = namesOf(items(g.get('measures')));
                for (Object o : items(g.get('rows'))) {
                    List<Object> row = (List<Object>) o;
                    List<Object> outRow = new List<Object>{ aliases[i] };
                    for (Object d : dims) outRow.add(pick(row, dimIdx.indexOf(nameOf(d))));
                    for (Object m : measures) {
                        Integer at = measureIdx.indexOf(nameOf(m));
                        outRow.add(pick(row, at < 0 ? -1 : dimIdx.size() + at));
                    }
                    rows.add(outRow);
                }
            }
            List<Object> dimensions = new List<Object>{ new Map<String, Object>{ 'name' => 'source', 'label' => 'Source', 'axis' => 'down' } };
            dimensions.addAll(dims);
            return new Map<String, Object>{ 'groups' => new Map<String, Object>{ 'dimensions' => dimensions, 'measures' => measures, 'rows' => rows } };
        }
        if (allDetail) {
            List<Object> allColumns = new List<Object>();
            Boolean truncated = false;
            for (Map<String, Object> r : results) {
                allColumns.addAll(items(detail(r).get('columns')));
                truncated = truncated || detail(r).get('truncated') == true;
            }
            List<Object> columns = unionByName(allColumns);
            List<Object> rows = new List<Object>();
            for (Integer i = 0; i < results.size(); i++) {
                Map<String, Object> d = detail(results[i]);
                List<String> idx = namesOf(items(d.get('columns')));
                for (Object o : items(d.get('rows'))) {
                    List<Object> row = (List<Object>) o;
                    List<Object> outRow = new List<Object>{ aliases[i] };
                    for (Object c : columns) outRow.add(pick(row, idx.indexOf(nameOf(c))));
                    rows.add(outRow);
                }
            }
            List<Object> all = new List<Object>{ new Map<String, Object>{ 'name' => 'source', 'label' => 'Source', 'dataType' => 'string' } };
            all.addAll(columns);
            return new Map<String, Object>{
                'detail' => new Map<String, Object>{ 'columns' => all, 'rows' => rows, 'rowCount' => rows.size(), 'truncated' => truncated }
            };
        }
        throw new CombineException(
            'To stack, every input must return grouped rows, or every input must return detail rows. Group all of them the same way, or run all of them with detail.'
        );
    }

    static Map<String, Object> join(List<String> aliases, List<Map<String, Object>> results, List<String> joinOn) {
        List<Map<String, Object>> groupsOf = new List<Map<String, Object>>();
        List<List<Integer>> idxOf = new List<List<Integer>>();
        for (Integer p = 0; p < results.size(); p++) {
            String alias = aliases[p];
            Map<String, Object> g = group(results[p]);
            if (g == null) throw new CombineException('Input "' + alias + '" has no groupings. Join needs grouped reports; use stack for flat tables.');
            List<Object> dims = items(g.get('dimensions'));
            List<String> dimNames = namesOf(dims);
            List<String> keys = joinOn;
            if (keys == null) {
                keys = new List<String>();
                for (Object d : dims) {
                    if (((Map<String, Object>) d).get('axis') == 'down') {
                        keys.add(nameOf(d));
                        break;
                    }
                }
            }
            if (keys.isEmpty()) throw new CombineException('Input "' + alias + '" has no down grouping to join on.');
            List<Integer> idx = new List<Integer>();
            List<String> missing = new List<String>();
            for (String k : keys) {
                idx.add(dimNames.indexOf(k));
                if (dimNames.indexOf(k) < 0) missing.add(k);
            }
            if (!missing.isEmpty()) {
                throw new CombineException('Input "' + alias + '" is not grouped by ' + String.join(missing, ', ') + '. It has: ' + String.join(dimNames, ', ') + '.');
            }
            if (dims.size() > keys.size()) {
                throw new CombineException('Input "' + alias + '" is grouped by more than the join key (' + String.join(dimNames, ', ')
                    + '). Set joinOn to all of its groupings, or remove the extra groupings.');
            }
            groupsOf.add(g);
            idxOf.add(idx);
        }

        List<Object> firstDims = items(groupsOf[0].get('dimensions'));
        List<Object> keyDims = new List<Object>();
        for (Integer i : idxOf[0]) {
            Map<String, Object> d = ((Map<String, Object>) firstDims[i]).clone();
            d.put('axis', 'down');
            keyDims.add(d);
        }
        List<Object> measures = new List<Object>();
        for (Integer p = 0; p < groupsOf.size(); p++) {
            for (Object o : items(groupsOf[p].get('measures'))) {
                Map<String, Object> m = (Map<String, Object>) o;
                measures.add(new Map<String, Object>{
                    'name' => aliases[p] + ':' + m.get('name'),
                    'label' => aliases[p] + ': ' + m.get('label'),
                    'dataType' => m.get('dataType')
                });
            }
        }

        // A full outer join on the trimmed, lower-case labels, in first-seen order.
        List<String> order = new List<String>();
        Map<String, List<Object>> labelsByKey = new Map<String, List<Object>>();
        Map<String, Map<String, List<Object>>> valuesByKey = new Map<String, Map<String, List<Object>>>();
        for (Integer p = 0; p < groupsOf.size(); p++) {
            Integer dimCount = items(groupsOf[p].get('dimensions')).size();
            for (Object o : items(groupsOf[p].get('rows'))) {
                List<Object> row = (List<Object>) o;
                List<Object> labels = new List<Object>();
                List<String> parts = new List<String>();
                for (Integer i : idxOf[p]) {
                    Object label = pick(row, i);
                    labels.add(label);
                    parts.add(label == null ? '' : String.valueOf(label).trim().toLowerCase());
                }
                String key = String.join(parts, '\u001F');
                if (!labelsByKey.containsKey(key)) {
                    order.add(key);
                    labelsByKey.put(key, labels);
                    valuesByKey.put(key, new Map<String, List<Object>>());
                }
                List<Object> values = new List<Object>();
                for (Integer i = dimCount; i < row.size(); i++) values.add(row[i]);
                valuesByKey.get(key).put(aliases[p], values);
            }
        }
        List<Object> rows = new List<Object>();
        for (String key : order) {
            List<Object> outRow = new List<Object>(labelsByKey.get(key));
            for (Integer p = 0; p < groupsOf.size(); p++) {
                List<Object> values = valuesByKey.get(key).get(aliases[p]);
                Integer count = items(groupsOf[p].get('measures')).size();
                for (Integer m = 0; m < count; m++) outRow.add(values == null ? null : pick(values, m));
            }
            rows.add(outRow);
        }
        return new Map<String, Object>{ 'groups' => new Map<String, Object>{ 'dimensions' => keyDims, 'measures' => measures, 'rows' => rows } };
    }

    static Map<String, Object> group(Map<String, Object> result) {
        return (Map<String, Object>) result.get('groups');
    }

    static Map<String, Object> detail(Map<String, Object> result) {
        return (Map<String, Object>) result.get('detail');
    }

    static List<Object> items(Object value) {
        return value == null ? new List<Object>() : (List<Object>) value;
    }

    static String nameOf(Object item) {
        return (String) ((Map<String, Object>) item).get('name');
    }

    static List<String> namesOf(List<Object> items) {
        List<String> out = new List<String>();
        for (Object item : items) out.add(nameOf(item));
        return out;
    }

    static Object pick(List<Object> row, Integer index) {
        return index < 0 || index >= row.size() ? null : row[index];
    }

    static List<Object> unionByName(List<Object> items) {
        Set<String> seen = new Set<String>();
        List<Object> out = new List<Object>();
        for (Object item : items) {
            if (seen.add(nameOf(item))) out.add(item);
        }
        return out;
    }
}
