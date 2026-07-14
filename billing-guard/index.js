const { CloudBillingClient } = require('@google-cloud/billing');

const billing = new CloudBillingClient();
const PROJECT_ID = process.env.TARGET_PROJECT_ID;

// 予算アラート(Pub/Sub経由)を受けて、実際の使用額が予算を超えていたら
// 対象プロジェクトの請求を無効化し、それ以上課金が発生しないようにする。
//
// 参考: https://cloud.google.com/billing/docs/how-to/notify#cap_disable_billing_to_stop_usage
exports.stopBillingOnBudgetExceeded = async (cloudEvent) => {
  const raw = Buffer.from(cloudEvent.data.message.data, 'base64').toString();
  const notification = JSON.parse(raw);
  console.log('予算通知を受信:', JSON.stringify(notification));

  const cost = notification.costAmount;
  const budget = notification.budgetAmount;

  if (typeof cost !== 'number' || typeof budget !== 'number' || cost <= budget) {
    console.log(`まだ予算内です(使用額 ${cost} / 予算 ${budget})。何もしません。`);
    return;
  }

  const projectName = `projects/${PROJECT_ID}`;
  const [billingInfo] = await billing.getProjectBillingInfo({ name: projectName });

  if (!billingInfo.billingEnabled) {
    console.log('既に請求は無効化されています。何もしません。');
    return;
  }

  console.log(`予算超過(使用額 ${cost} > 予算 ${budget})。${projectName} の請求を無効化します。`);
  await billing.updateProjectBillingInfo({
    name: projectName,
    projectBillingInfo: { billingAccountName: '' },
  });
  console.log('請求を無効化しました。Cloud Runなど課金対象のリソースは停止します。');
};
