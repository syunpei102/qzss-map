const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function runDeploy(envOverrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzss-deploy-test-'));
  const argsFile = path.join(dir, 'args');
  const gcloud = path.join(dir, 'gcloud');
  fs.writeFileSync(gcloud, `#!/bin/sh
if [ "$1 $2 $3" = "run services describe" ]; then
  [ "$GCLOUD_TEST_EXISTS" = "true" ] || exit 1
  case "$*" in *--format=*) echo 'https://example.test' ;; esac
  exit 0
fi
if [ "$1 $2" = "run deploy" ]; then
  printf '%s\\n' "$@" > "$GCLOUD_TEST_ARGS"
  exit 0
fi
exit 1
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GCLOUD_TEST_ARGS: argsFile,
    GCLOUD_TEST_EXISTS: 'true', INGEST_TOKEN: '', VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '', DISCORD_PUBLIC_KEY: '', DISCORD_ADMIN_USER_ID: '',
    ENABLE_WEB_ADMIN: '', ADMIN_EMAIL: '', ADMIN_PASSWORD_HASH: '', SESSION_SECRET: '',
    ...envOverrides };
  try {
    const result = spawnSync('bash', ['deploy_gcloud.sh'], { cwd: ROOT, env, encoding: 'utf8' });
    return { result, args: fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8') : '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('redeploy preserves existing keys and never prints a token', () => {
  const { result, args } = runDeploy({ GCLOUD_TEST_EXISTS: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(args, /--update-env-vars|--set-env-vars/);
  assert.match(args, /--max-instances\n1/);
  assert.doesNotMatch(result.stdout, /QZSS_INGEST_TOKEN=/);
});

test('deploy updates only explicitly supplied keys', () => {
  const { result, args } = runDeploy({ INGEST_TOKEN: 'example-secret', DISCORD_PUBLIC_KEY: 'example-public' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(args, /--update-env-vars\nINGEST_TOKEN=example-secret,DISCORD_PUBLIC_KEY=example-public/);
  assert.doesNotMatch(args, /VAPID_PUBLIC_KEY|VAPID_PRIVATE_KEY/);
  assert.doesNotMatch(result.stdout, /example-secret/);
});

test('first deploy without a token fails before changing Cloud Run', () => {
  const { result, args } = runDeploy({ GCLOUD_TEST_EXISTS: 'false' });
  assert.notEqual(result.status, 0);
  assert.equal(args, '');
});
