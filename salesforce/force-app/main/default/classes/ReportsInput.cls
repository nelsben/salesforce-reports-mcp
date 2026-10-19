/**
 * Core layer: reading a tool's JSON input. parse turns the request body text into a map, and the opt and req helpers
 * read one typed field from it. Each refusal is an invalid input ReportsException with the message the local server
 * gives. It knows nothing of HTTP: a door hands the core the body text, and the core reads the fields through here.
 */
public with sharing class ReportsInput {
    public static Map<String, Object> parse(String body) {
        if (String.isBlank(body)) return new Map<String, Object>();
        Object parsed;
        try {
            parsed = JSON.deserializeUntyped(body);
        } catch (JSONException e) {
            throw ReportsException.invalidInput('The request body is not JSON.');
        }
        if (parsed == null) return new Map<String, Object>();
        return asMap(parsed, 'The request body');
    }

    public static Map<String, Object> asMap(Object value, String what) {
        if (value instanceof Map<String, Object>) return (Map<String, Object>) value;
        throw ReportsException.invalidInput(what + ' must be a JSON object.');
    }

    public static String optString(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (v == null) return null;
        if (v instanceof String) return (String) v;
        throw ReportsException.invalidInput(key + ' must be a string.');
    }

    public static String reqString(Map<String, Object> m, String key) {
        String v = optString(m, key);
        if (v == null) throw ReportsException.invalidInput(key + ' is required.');
        return v;
    }

    public static Boolean optBool(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (v == null) return null;
        if (v instanceof Boolean) return (Boolean) v;
        throw ReportsException.invalidInput(key + ' must be true or false.');
    }

    public static Integer optInt(Map<String, Object> m, String key, Integer min, Integer max) {
        Object v = m.get(key);
        if (v == null) return null;
        Decimal d;
        if (v instanceof Integer) d = (Integer) v;
        else if (v instanceof Long) d = (Long) v;
        else if (v instanceof Decimal) d = (Decimal) v;
        if (d == null || d != d.round(System.RoundingMode.DOWN) || d < min || d > max) {
            throw ReportsException.invalidInput(key + ' must be a whole number from ' + min + ' to ' + max + '.');
        }
        return d.intValue();
    }

    public static Map<String, Object> optMap(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v == null ? null : asMap(v, key);
    }

    public static List<Object> optList(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (v == null) return null;
        if (v instanceof List<Object>) return (List<Object>) v;
        throw ReportsException.invalidInput(key + ' must be a list.');
    }

    public static List<String> optStringList(Map<String, Object> m, String key) {
        List<Object> raw = optList(m, key);
        if (raw == null) return null;
        List<String> out = new List<String>();
        for (Object o : raw) {
            if (!(o instanceof String)) throw ReportsException.invalidInput(key + ' must be a list of strings.');
            out.add((String) o);
        }
        return out;
    }

    /** A dashboard id: 01Z plus 12 to 15 characters, as the local tools check it. */
    public static String dashboardId(Map<String, Object> m, String key) {
        String value = reqString(m, key);
        if (!Pattern.matches('01Z[A-Za-z0-9]{12,15}', value)) throw ReportsException.invalidInput('A dashboard id starts with 01Z.');
        return value;
    }

    /** A report id: 00O plus 12 to 15 characters, and a valid Id. */
    public static Id reportId(Map<String, Object> m, String key) {
        String value = reqString(m, key);
        if (!Pattern.matches('00O[A-Za-z0-9]{12,15}', value)) throw ReportsException.invalidInput('A report id starts with 00O.');
        try {
            return Id.valueOf(value);
        } catch (Exception e) {
            throw ReportsException.invalidInput('A report id starts with 00O.');
        }
    }
}
