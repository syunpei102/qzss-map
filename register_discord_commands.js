// Discordのスラッシュコマンド(/reboot, /update_check, /set_region)を
// 登録するだけのローカル専用スクリプト。デプロイはしない。コマンドの
// 定義を変えた時だけ、もう一度実行すればよい(既存の同名コマンドは
// 上書きされる)。
//
// 使い方:
//   DISCORD_BOT_TOKEN=xxxx \
//   DISCORD_APPLICATION_ID=xxxx \
//   DISCORD_GUILD_ID=xxxx \
//   node register_discord_commands.js
//
// guild(サーバー)限定のコマンドとして登録する(global登録は反映まで
// 最大1時間かかるため、個人利用ではguild限定の方が扱いやすい)。

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!BOT_TOKEN || !APPLICATION_ID || !GUILD_ID) {
  console.error("使い方: DISCORD_BOT_TOKEN=xxxx DISCORD_APPLICATION_ID=xxxx DISCORD_GUILD_ID=xxxx node register_discord_commands.js");
  process.exit(1);
}

const STRING_OPTION_TYPE = 3;
const BOOLEAN_OPTION_TYPE = 5;

const deviceOption = {
  name: "device",
  description: "対象の拠点ID(QZSS_DEVICE_ID)",
  type: STRING_OPTION_TYPE,
  required: true,
  autocomplete: true,
};

const optionalDeviceOption = {
  ...deviceOption,
  description: "対象の拠点ID(省略すると拠点ごとの設定が無い端末すべてに適用される)",
  required: false,
};

const commands = [
  {
    name: "reboot",
    description: "拠点(ラズパイ)の再起動を予約する(次回の状態報告時に実行されます)",
    options: [deviceOption],
  },
  {
    name: "update_check",
    description: "拠点(ラズパイ)の更新確認を予約する",
    options: [deviceOption],
  },
  {
    name: "set_region",
    description: "拠点の対象地域(都道府県)を設定する。未指定に戻すにはclear_regionを使う",
    options: [
      deviceOption,
      {
        name: "prefecture",
        description: "対象の都道府県",
        type: STRING_OPTION_TYPE,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "clear_region",
    description: "拠点の対象地域設定を解除し、絞り込み無し(全国)に戻す",
    options: [deviceOption],
  },
  {
    name: "create_device_token",
    description: "拠点用のINGEST_TOKENを新規発行する(既存の拠点に対して行うと再発行=旧トークン失効)",
    options: [deviceOption],
  },
  {
    name: "set_training_broadcasts",
    description: "訓練/試験放送(月2回程度)を地図に表示するか設定する。deviceを指定すればその拠点だけ、省略すれば全体に適用",
    options: [
      {
        name: "enabled",
        description: "表示するかどうか",
        type: BOOLEAN_OPTION_TYPE,
        required: true,
      },
      optionalDeviceOption,
    ],
  },
  {
    name: "delete_device",
    description: "拠点の記録を全て削除する(状態報告履歴・地域設定・トークン失効・訓練放送設定)。元に戻せません",
    options: [deviceOption],
  },
];

async function main() {
  const res = await fetch(
    `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    }
  );
  const body = await res.json();
  if (!res.ok) {
    console.error("❌ コマンド登録に失敗しました:", res.status, JSON.stringify(body, null, 2));
    process.exit(1);
  }
  console.log(`✅ ${body.length}件のコマンドを登録しました:`, body.map((c) => c.name).join(", "));
}

main();
