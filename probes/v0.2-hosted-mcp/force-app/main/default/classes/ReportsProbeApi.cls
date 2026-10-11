// Probe 1 and 2: the smallest Apex REST class a hosted MCP server could wrap.
@RestResource(urlMapping='/reportsprobe/v1/*')
global with sharing class ReportsProbeApi {
    global class PingResult {
        global String message;
        global String userName;
    }

    @HttpGet
    global static PingResult ping() {
        PingResult r = new PingResult();
        r.message = 'pong';
        r.userName = UserInfo.getUserName();
        return r;
    }
}
