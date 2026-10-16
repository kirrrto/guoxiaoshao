'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const connection = require('../../cloudfunctions/gxs_api/lib/connection');
const { createCollector } = require('../../cloudfunctions/gxs_api/lib/engine/collector');
const { createWechatSender } = require('../../cloudfunctions/gxs_api/lib/engine/wechat-sender');

function runtimeOptions(env = process.env) {
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  return { enabled: env.GXS_ENABLE_COLLECTOR_PROCESS === 'true', port,
    envId: env.GXS_CLOUDBASE_ENV || connection.envId, region: env.GXS_CLOUDBASE_REGION || connection.region,
    appid: env.GXS_CONSUMER_APPID || '', appSecret: env.GXS_CONSUMER_APPSECRET || '',
    expectedAppid: connection.consumerAppid };
}

async function start({ env = process.env, repo: injectedRepo, fetchImpl = globalThis.fetch, log = console } = {}) {
  const options = runtimeOptions(env);
  let stopping = false;
  let collector = null;
  let heartbeat = null;
  let fatal = null;
  let lastLoopAt = Date.now();
  let work = Promise.resolve();
  const sender = createWechatSender({ appid: options.appid, appSecret: options.appSecret, expectedAppid: options.expectedAppid, fetchImpl });
  if (options.enabled) {
    let repo = injectedRepo;
    if (!repo) {
      const cloud = require('wx-server-sdk');
      const { createCloudbaseRepo } = require('../../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
      // Cloud Run workload credentials (or least-privilege environment secrets)
      // are read by the SDK; no implicit WeChat openapi credentials are used.
      cloud.init({ env: options.envId, region: options.region, timeout: 8000 });
      repo = createCloudbaseRepo(cloud.database());
    }
    const saveStatus = repo.saveCollectorStatus.bind(repo);
    repo.saveCollectorStatus = async (status, lease) => { const result = await saveStatus(status, lease); if (!result || result.saved !== false) heartbeat = structuredClone(status); return result; };
    const acquireLease = repo.acquireLease.bind(repo);
    repo.acquireLease = async input => { const result = await acquireLease(input); lastLoopAt = Date.now(); return result; };
    collector = createCollector({ repo, fetchImpl, sendImpl: sender, log,
      ownerId: `collector-${crypto.randomUUID()}` });
  }
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || !['/healthz', '/readyz'].includes(req.url)) { res.writeHead(404); res.end(); return; }
    const fresh = heartbeat && Date.parse(heartbeat.expiresAt) > Date.now();
    const stalled = options.enabled && Date.now() - lastLoopAt > 60000;
    const ready = Boolean(options.enabled && !stopping && !fatal && !stalled && fresh && !['stopped', 'no_lease', 'disabled'].includes(heartbeat.state));
    res.writeHead(req.url === '/readyz' && !ready ? 503 : fatal || stalled ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ alive: !fatal && !stalled, ready, state: stopping ? 'stopping' : !options.enabled ? 'disabled' : heartbeat ? fresh ? heartbeat.state : 'stale' : 'starting_or_standby',
      updatedAt: heartbeat && heartbeat.updatedAt, notifications: heartbeat && heartbeat.notifications || { enabled: options.enabled && sender.enabled, reason: sender.disabledReason },
      reason: fatal || (stalled ? 'collector_loop_stalled' : !options.enabled ? 'process_switch_disabled' : null) }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, '0.0.0.0', resolve); });
  if (collector) work = collector.run().catch(error => { fatal = 'collector_stopped_unexpectedly'; log.error('[collector] fatal', error && error.code || 'runtime_error'); });
  log.info(`[collector] health listening on ${options.port}; process=${options.enabled ? 'enabled' : 'disabled'}; notifications=${sender.enabled ? 'configured' : sender.disabledReason}`);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (collector) collector.stop();
    await work;
    await new Promise(resolve => server.close(resolve));
  };
  return { server, collector, stop, options: { ...options, appSecret: undefined }, getStatus: () => heartbeat };
}

if (require.main === module) {
  if (process.argv.includes('--check-config')) {
    const options = runtimeOptions();
    console.log(JSON.stringify({ valid: true, processEnabled: options.enabled, port: options.port, envId: options.envId,
      credentialsConfigured: Boolean(options.appid && options.appSecret), consumerAppidMatches: options.appid === options.expectedAppid }));
  } else {
    start().then(runtime => {
      let closing = false;
      const close = () => {
        if (closing) return;
        closing = true;
        const deadline = setTimeout(() => process.exit(1), 30000);
        deadline.unref();
        runtime.stop().then(() => { clearTimeout(deadline); process.exit(0); }, () => process.exit(1));
      };
      process.on('SIGTERM', close); process.on('SIGINT', close);
    }).catch(error => { console.error('[collector] startup failed', error && error.code || error.message); process.exitCode = 1; });
  }
}

module.exports = { start, runtimeOptions };
