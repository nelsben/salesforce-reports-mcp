function reportResultToRows({ answer }) {
  var fail = function (e) {
    if (e && typeof e === "object") {
      var parts = [e.message, e.code, e.hint].filter(function (x) { return typeof x === "string" && x; });
      if (parts.length) return new Error(parts.join(" "));
    }
    return new Error(typeof e === "string" && e ? e : "The answer carried an error.");
  };
  var parse = function (text) {
    try { return JSON.parse(text); } catch (e) { throw new Error("The answer is not a ReportResult: it is text that is not JSON."); }
  };
  var textOf = function (a) {
    var c = a && a.content;
    return Array.isArray(c) && c[0] && typeof c[0].text === "string" ? c[0].text : "";
  };
  var r = answer;
  if (typeof r === "string") r = parse(r);
  if (r && typeof r === "object" && r.isError) throw fail(textOf(r) || r.error);
  if (r && typeof r === "object" && r.structuredContent && typeof r.structuredContent === "object") r = r.structuredContent;
  else if (r && typeof r === "object" && !r.report && Array.isArray(r.content) && textOf(r)) r = parse(textOf(r));
  if (r && typeof r === "object" && r.isError) throw fail(textOf(r) || r.error);
  if (r && typeof r === "object" && r.error) throw fail(r.error);
  if (!r || typeof r !== "object" || !r.report || (!r.groups && !r.detail)) {
    throw new Error("The answer is not a ReportResult: it has no report and no groups or detail.");
  }

  var columns = [];
  var rows = [];
  var unique = function (heading, fallback) {
    return heading && columns.indexOf(heading) < 0 ? heading : fallback;
  };
  if (r.groups) {
    var dims = r.groups.dimensions || [];
    var meas = r.groups.measures || [];
    var all = dims.concat(meas);
    var heads = [];
    all.forEach(function (c) {
      var h = unique(c.label, c.name);
      heads.push(h);
      columns.push(h);
    });
    (r.groups.rows || []).forEach(function (row) {
      var o = {};
      heads.forEach(function (h, i) { o[h] = row[i]; });
      rows.push(o);
    });
    var tm = (r.totals && r.totals.measures) || [];
    var tv = (r.totals && r.totals.values) || [];
    var total = {};
    heads.forEach(function (h, i) { total[h] = i === 0 ? "Total" : ""; });
    tm.forEach(function (name, i) {
      var at = -1;
      meas.forEach(function (m, j) { if (m.name === name) at = dims.length + j; });
      if (at >= 0) total[heads[at]] = tv[i];
    });
    rows.push(total);
  } else {
    var cols = r.detail.columns || [];
    cols.forEach(function (c) { columns.push(c.name); });
    (r.detail.rows || []).forEach(function (row) {
      var o = {};
      cols.forEach(function (c, i) { o[c.name] = row[i]; });
      rows.push(o);
    });
  }

  var notes = Array.isArray(r.notes) ? r.notes : [];
  var cut = !!(r.detail && r.detail.truncated === true) ||
    notes.some(function (n) { return /\b(cut|truncated)\b|showing \d+ of \d+/i.test(String(n)); });
  var meta = [];
  if (r.report.url) meta.push({ label: "Report", value: String(r.report.url) });
  (Array.isArray(r.filters) ? r.filters : []).forEach(function (f) { meta.push({ label: "Filter", value: String(f) }); });
  notes.forEach(function (n) { meta.push({ label: "Note", value: String(n) }); });
  return { columns: columns, rows: rows, cut: cut, meta: meta };
}
if (typeof module !== "undefined") module.exports = reportResultToRows;
