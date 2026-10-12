// Calls the org's own REST API through the named credential SalesforceReportsSelf,
// as the running user. For each path it prints the status code and the first
// 200 characters of the body. The identity calls print only whether the user they
// name is the running user, so no id or username reaches the log.
// The run fails unless both report calls answer 200 and one identity call names
// the running user.
String base = 'callout:SalesforceReportsSelf';
List<String> paths = new List<String>{
    '/services/data/v68.0/analytics/reportTypes',
    '/services/data/v68.0/analytics/reports',
    '/services/data/v68.0/chatter/users/me',
    '/services/oauth2/userinfo'
};
Map<String, Integer> statusByPath = new Map<String, Integer>();
List<String> lines = new List<String>();
Boolean identityMatches = false;
for (String path : paths) {
    HttpRequest req = new HttpRequest();
    req.setEndpoint(base + path);
    req.setMethod('GET');
    req.setTimeout(60000);
    try {
        HttpResponse res = new Http().send(req);
        Integer status = res.getStatusCode();
        String body = res.getBody() == null ? '' : res.getBody();
        String shown = body.left(200);
        if (status == 200 && (path.endsWith('/users/me') || path.endsWith('/userinfo'))) {
            Map<String, Object> who = (Map<String, Object>) JSON.deserializeUntyped(body);
            Object id = who.containsKey('user_id') ? who.get('user_id') : who.get('id');
            Object name = who.containsKey('preferred_username') ? who.get('preferred_username') : who.get('username');
            Boolean idMatch = String.valueOf(id) == UserInfo.getUserId();
            Boolean nameMatch = String.valueOf(name) == UserInfo.getUserName();
            identityMatches = identityMatches || (idMatch && nameMatch);
            shown = 'user id is the running user: ' + idMatch + '; username is the running user: ' + nameMatch;
        }
        statusByPath.put(path, status);
        lines.add('PROBE ' + path + ' status=' + status + ' body=' + shown);
    } catch (Exception e) {
        statusByPath.put(path, -1);
        lines.add('PROBE ' + path + ' exception=' + e.getTypeName() + ': ' + e.getMessage());
    }
}
Boolean ok = statusByPath.get(paths[0]) == 200 && statusByPath.get(paths[1]) == 200 && identityMatches;
lines.add('PROBE result ok=' + ok);
for (String line : lines) {
    System.debug(LoggingLevel.ERROR, line);
}
Assert.isTrue(ok, '\n' + String.join(lines, '\n'));
