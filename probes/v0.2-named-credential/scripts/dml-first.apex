// Shows the platform limit on a callout after DML in the same transaction.
// It inserts an Account and does not commit it, then calls out through the
// named credential. The run always ends in a failed assertion, so the insert
// is rolled back and nothing is left in the org.
insert new Account(Name = 'zz named credential probe');
String outcome;
try {
    HttpRequest req = new HttpRequest();
    req.setEndpoint('callout:SalesforceReportsSelf/services/data/v68.0/analytics/reportTypes');
    req.setMethod('GET');
    HttpResponse res = new Http().send(req);
    outcome = 'status=' + res.getStatusCode();
} catch (Exception e) {
    outcome = e.getTypeName() + ': ' + e.getMessage();
}
Assert.isTrue(false, 'Rolled back on purpose. Callout after DML: ' + outcome);
