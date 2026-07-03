const Redis = require('ioredis');
const r = new Redis({ host: 'localhost', port: 6379, lazyConnect: true });
(async () => {
  try {
    await r.connect();
    const keys = await r.keys('*otp*');
    if (keys.length) await r.del(...keys);
    console.log(`Cleared ${keys.length} OTP keys`);
  } catch (e) { console.error('err:', e.message); }
  finally { r.disconnect(); }
})();
