const Redis = require('ioredis');
const r = new Redis({ host: 'localhost', port: 6379, lazyConnect: true });
(async () => {
  try {
    await r.connect();
    const all = await r.keys('*');
    console.log(`Total keys: ${all.length}`);
    const otp = all.filter(k => k.startsWith('otp'));
    console.log(`otp* keys: ${otp.length}`);
    if (otp.length) console.log(otp.slice(0, 30));
    const setupGrace = all.filter(k => k.startsWith('setup-grace'));
    console.log(`setup-grace* keys: ${setupGrace.length}`);
    console.log(`Sample first 10 keys:`, all.slice(0, 10));
  } catch (e) { console.error('err:', e.message); }
  finally { r.disconnect(); }
})();
