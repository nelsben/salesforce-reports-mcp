@IsTest
private class ReportsProbeLabTest {
    @IsTest
    static void syntheticShapeRuns() {
        RestContext.request = new RestRequest();
        RestContext.request.requestURI = '/reportsprobelab/v1/synthetic';
        RestContext.request.addParameter('rows', '5');
        RestContext.request.addParameter('cols', '4');
        RestContext.response = new RestResponse();
        Test.startTest();
        ReportsProbeLab.doGet();
        Test.stopTest();
        System.assert(RestContext.response.responseBody.toString().contains('jsonBytes'));
    }

    @IsTest
    static void unknownOpReportsError() {
        RestContext.request = new RestRequest();
        RestContext.request.requestURI = '/reportsprobelab/v1/nope';
        RestContext.response = new RestResponse();
        ReportsProbeLab.doGet();
        System.assert(RestContext.response.responseBody.toString().contains('unknown op'));
    }
}
