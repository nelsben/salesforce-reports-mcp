@IsTest
private class ReportsProbeApiTest {
    @IsTest
    static void pingReturnsPong() {
        System.assertEquals('pong', ReportsProbeApi.ping().message);
    }
}
