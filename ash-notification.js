// 降灰予報は一つの発表が地域別の複数電文に分かれる．通知は発表単位にまとめる．
function ashIssueKey(report) {
  const scope = report.is_test_data ? 'test' : report.report_classification_no === 7 ? 'training' : 'live';
  const volcano = report.volcano_name_raw ?? report.volcano_name ?? 'unknown';
  return `n:ashfall|${scope}|${volcano}|${report.activity_time || ''}|${report.report_time || ''}`;
}

function ashNotificationBody(report) {
  const volcano = report.volcano_name || '火山';
  return `${volcano}の降灰予報．対象地域を地図で確認してください．`;
}

module.exports = { ashIssueKey, ashNotificationBody };
