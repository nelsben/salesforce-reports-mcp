@IsTest
private class ReportsCombineTest {
    static Map<String, Object> result(String text) {
        return (Map<String, Object>) JSON.deserializeUntyped(text);
    }

    static Map<String, Object> grouped(String dims, String rows) {
        return result('{"filters":["Close Date: THIS_YEAR"],"notes":["cut"],"groups":{"dimensions":' + dims
            + ',"measures":[{"name":"RowCount","label":"Record Count","dataType":"int"}],"rows":' + rows + '}}');
    }

    static final String BY_OWNER = '[{"name":"FULL_NAME","label":"Owner","axis":"down"}]';

    @IsTest
    static void stacksGroupsAndDetail() {
        Map<String, Object> out = ReportsCombine.combineResults('stack', new List<String>{ 'a', 'b' },
            new List<Map<String, Object>>{ grouped(BY_OWNER, '[["Ann",2]]'), grouped('[{"name":"STAGE_NAME","label":"Stage","axis":"down"}]', '[["Won",3]]') }, null);
        Map<String, Object> groups = (Map<String, Object>) out.get('groups');
        Assert.areEqual(3, ((List<Object>) groups.get('dimensions')).size());
        Assert.areEqual(new List<Object>{ 'a', 'Ann', null, 2 }, ((List<Object>) groups.get('rows'))[0]);
        Assert.areEqual(new List<Object>{ 'b', null, 'Won', 3 }, ((List<Object>) groups.get('rows'))[1]);
        Assert.areEqual(new List<Object>{ 'a: Close Date: THIS_YEAR', 'b: Close Date: THIS_YEAR' }, out.get('filters'));
        Assert.areEqual('combined: a, b', ((Map<String, Object>) out.get('report')).get('name'));

        Map<String, Object> d1 = result('{"filters":[],"notes":[],"detail":{"columns":[{"name":"A","label":"A","dataType":"string"}],"rows":[["x"]],"rowCount":1,"truncated":false}}');
        Map<String, Object> d2 = result('{"filters":[],"notes":[],"detail":{"columns":[{"name":"B","label":"B","dataType":"string"}],"rows":[["y"]],"rowCount":1,"truncated":true}}');
        Map<String, Object> detail = (Map<String, Object>) ReportsCombine.combineResults('stack', new List<String>{ 'a', 'b' }, new List<Map<String, Object>>{ d1, d2 }, null).get('detail');
        Assert.areEqual(true, detail.get('truncated'));
        Assert.areEqual(new List<Object>{ 'b', null, 'y' }, ((List<Object>) detail.get('rows'))[1]);

        try {
            ReportsCombine.combineResults('stack', new List<String>{ 'a', 'b' }, new List<Map<String, Object>>{ d1, grouped(BY_OWNER, '[]') }, null);
            Assert.fail('mixed inputs should not stack');
        } catch (ReportsCombine.CombineException e) {
            Assert.isTrue(e.getMessage().startsWith('To stack'));
        }
    }

    @IsTest
    static void joinsAsAFullOuterJoin() {
        Map<String, Object> out = ReportsCombine.combineResults('join', new List<String>{ 'open', 'won' },
            new List<Map<String, Object>>{ grouped(BY_OWNER, '[["Ann",2],["Bo",1]]'), grouped(BY_OWNER, '[[" ann ",5],["Cy",4]]') }, null);
        Map<String, Object> groups = (Map<String, Object>) out.get('groups');
        List<Object> rows = (List<Object>) groups.get('rows');
        Assert.areEqual(3, rows.size());
        Assert.areEqual(new List<Object>{ 'Ann', 2, 5 }, rows[0]);
        Assert.areEqual(new List<Object>{ 'Bo', 1, null }, rows[1]);
        Assert.areEqual(new List<Object>{ 'Cy', null, 4 }, rows[2]);
        Assert.areEqual('open: Record Count', ((Map<String, Object>) ((List<Object>) groups.get('measures'))[0]).get('label'));
        Assert.areEqual('SUMMARY', ((Map<String, Object>) out.get('report')).get('format'));
    }

    @IsTest
    static void refusesWhatCannotCombine() {
        Map<String, Object> flat = result('{"filters":[],"notes":[]}');
        Map<String, Object> matrix = grouped('[{"name":"FULL_NAME","label":"Owner","axis":"down"},{"name":"CLOSE_DATE","label":"Close","axis":"across"}]', '[]');
        Map<String, Object> acrossOnly = grouped('[{"name":"CLOSE_DATE","label":"Close","axis":"across"}]', '[]');
        List<List<Object>> cases = new List<List<Object>>{
            new List<Object>{ 'join', new List<String>{ 'a' }, new List<Map<String, Object>>{ flat }, null },
            new List<Object>{ 'join', new List<String>{ 'a', 'a' }, new List<Map<String, Object>>{ flat, flat }, null },
            new List<Object>{ 'join', new List<String>{ 'a', 'b' }, new List<Map<String, Object>>{ flat, flat }, null },
            new List<Object>{ 'join', new List<String>{ 'a', 'b' }, new List<Map<String, Object>>{ grouped(BY_OWNER, '[]'), grouped(BY_OWNER, '[]') }, new List<String>{ 'STAGE_NAME' } },
            new List<Object>{ 'join', new List<String>{ 'a', 'b' }, new List<Map<String, Object>>{ matrix, matrix }, null },
            new List<Object>{ 'join', new List<String>{ 'a', 'b' }, new List<Map<String, Object>>{ acrossOnly, acrossOnly }, null }
        };
        for (List<Object> c : cases) {
            try {
                ReportsCombine.combineResults((String) c[0], (List<String>) c[1], (List<Map<String, Object>>) c[2], (List<String>) c[3]);
                Assert.fail('expected an error for ' + c);
            } catch (ReportsCombine.CombineException e) {
                Assert.isNotNull(e.getMessage());
            }
        }
    }
}
