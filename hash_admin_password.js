// 管理サイト(/device-admin)用パスワードのハッシュ値を生成するだけの
// ローカル専用CLI。デプロイはしない。
//
// 使い方:
//   node hash_admin_password.js 'あなたのパスワード'
// 出力された文字列をそのまま ADMIN_PASSWORD_HASH としてCloud Runの
// 環境変数に設定する:
//   gcloud run deploy qzss-map --update-env-vars ADMIN_PASSWORD_HASH='...'
const crypto = require("crypto");

const password = process.argv[2];
if (!password) {
  console.error("使い方: node hash_admin_password.js 'パスワード'");
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 64);
console.log(`${salt.toString("hex")}:${hash.toString("hex")}`);
