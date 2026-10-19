// 公式の訓練放送で表示・通知する範囲をサーバーとブラウザで共有する．
// 通常の災害情報と手動のテストデータには適用しない．
(function (root, factory) {
  const filter = factory();
  if (typeof module === 'object' && module.exports) module.exports = filter;
  else root.TrainingReportFilter = filter;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TRAINING_CATEGORIES = new Set([1, 2, 3, 5]);
  const TSUNAMI_CODES = new Set([1, 2, 3, 4, 5]);

  function isOfficialTraining(report) {
    return report?.report_classification_no === 7 || report?.a1_message_type === 'Test';
  }

  function shouldProcess(report) {
    // Lアラートは本番・訓練とも公開画面とプッシュ通知から除外する．
    if (report?.type === 'QzssDcxLAlert' || report?.type === 'QzssDcxMTInfo') return false;
    if (!isOfficialTraining(report)) return true;
    // Jアラートの試験電文は訓練として表示・通知する．
    if (report?.type === 'QzssDcxJAlert' && report.a1_message_type === 'Test') return true;
    if (report?.report_classification_no !== 7) return false; // DCXの試験・Lアラートを除外
    if (!TRAINING_CATEGORIES.has(report.disaster_category_no)) return false;
    if (report.disaster_category_no !== 5) return true;
    // 津波注意報やその他の注意情報は除外する．解除と取消は残存表示を消すため通す．
    return report.information_type_no === 2 || TSUNAMI_CODES.has(report.tsunami_warning_code_raw);
  }

  function sameDisplayScope(record, report) {
    return !!record?.isTestData === !!report?.is_test_data
      && !!record?.isTraining === isOfficialTraining(report);
  }

  return { isOfficialTraining, shouldProcess, sameDisplayScope };
});
