/**
 * Core layer: the one error type the core throws. A failure carries a code, a message, an optional hint and a
 * category (invalid input, forbidden, unknown tool or failed), and never an HTTP status: the door that called the core
 * decides what a category means on its wire, and ReportsApi alone maps it to 400, 403, 404 or 500. fromException turns
 * any other exception into one, with the code and hint src/format.ts gives it. It names no door.
 */
public with sharing class ReportsException extends Exception {
    /** What kind of failure this is. INVALID_INPUT also covers a request Salesforce refused as bad (a 4xx). */
    public enum ErrorCategory { INVALID_INPUT, FORBIDDEN, UNKNOWN_TOOL, FAILED }

    public static final String ID_HINT = 'Check the id with search_reports (reports) or list_report_types (report types).';

    public ErrorCategory category = ErrorCategory.INVALID_INPUT;
    public String code = 'INVALID_INPUT';
    public String hintText;

    public static ReportsException create(ErrorCategory category, String code, String message, String hintText) {
        ReportsException e = new ReportsException(message);
        e.category = category;
        e.code = code;
        e.hintText = hintText;
        return e;
    }

    /** Bad input, with the message the local server gives for it. */
    public static ReportsException invalidInput(String message) {
        return create(ErrorCategory.INVALID_INPUT, 'INVALID_INPUT', message, null);
    }

    /** A failure that is not the caller's input: a callout, the heap, an unexpected error. */
    public static ReportsException failed(String code, String message, String hintText) {
        return create(ErrorCategory.FAILED, code, message, hintText);
    }

    /** Any exception as a core error, as src/format.ts describes it. A ReportsException comes back as it is. */
    public static ReportsException fromException(Exception e) {
        if (e instanceof ReportsException) return (ReportsException) e;
        if (e instanceof ReportsCombine.CombineException) return invalidInput(e.getMessage());
        String type = e.getTypeName();
        if (type.startsWithIgnoreCase('Reports.')) {
            String code = type.substringAfter('.').removeEnd('Exception').replaceAll('([a-z])([A-Z])', '$1_$2').toUpperCase();
            return create(ErrorCategory.INVALID_INPUT, code, e.getMessage(), hintFor(code, e.getMessage()));
        }
        if (e instanceof JSONException || e instanceof StringException || e instanceof TypeException) {
            return invalidInput(e.getMessage());
        }
        if (e instanceof NoAccessException) {
            return failed('INSUFFICIENT_ACCESS', e.getMessage(), hintFor('INSUFFICIENT_ACCESS', e.getMessage()));
        }
        return failed('UNEXPECTED', String.isEmpty(e.getMessage()) ? 'Unexpected error.' : e.getMessage(), null);
    }

    /**
     * src/format.ts hintFor, less its test for an HTTP 404: ReportsCallout makes that test on the upstream status and
     * answers ID_HINT. A 401 never gets here: ReportsCallout answers it with CALLOUT_SESSION.
     */
    public static String hintFor(String code, String message) {
        String text = code + ' ' + message;
        if (Pattern.compile('(?i)NOT_FOUND|INVALID_ID').matcher(code).find()) {
            return ID_HINT;
        }
        if (Pattern.compile('(?i)column|field|grouping|aggregate|filter|operator').matcher(text).find()) {
            return 'Check column API names, filter operators and aggregates with describe_report_type, or the report\'s own columns with describe_report.';
        }
        if (Pattern.compile('(?i)REQUEST_LIMIT_EXCEEDED|limit').matcher(text).find()) {
            return 'Salesforce allows 500 synchronous report runs per org per hour. Wait, or reduce the number of runs.';
        }
        if (Pattern.compile('(?i)INSUFFICIENT_ACCESS|FORBIDDEN|permission').matcher(text).find()) {
            return 'The authenticated user lacks access. They need the Run Reports permission, and for saving, Create and Customize Reports.';
        }
        return null;
    }
}
