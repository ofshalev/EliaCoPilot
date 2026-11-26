const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
async function hashPassword(password) {
  if(typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('Password must contain 12–128 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + (await scrypt(password,salt,64)).toString('hex');
}
async function verifyPassword(password, stored) {
  if(typeof password !== 'string' || password.length > 128 || !stored) return false;
  const [salt,hash] = stored.split(':');
  const actual = await scrypt(password,salt,64);
  const expected = Buffer.from(hash,'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected,actual);
}
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
async function initialize(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS cloud_users (
    username text PRIMARY KEY CHECK(username ~ '^[a-z0-9_]{3,32}$'),
    display_name text NOT NULL, role text NOT NULL CHECK(role IN ('admin','user')),
    password_hash text, active boolean NOT NULL DEFAULT false
  );
  CREATE TABLE IF NOT EXISTS cloud_sessions (
    token_hash text PRIMARY KEY, username text NOT NULL REFERENCES cloud_users(username) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
  );`);
  for(const username of ['ofer','roni','ofri','rotem']) {
    await pool.query('INSERT INTO cloud_users(username,display_name,role) VALUES($1,$1,$2) ON CONFLICT DO NOTHING',[username,username==='ofer'?'admin':'user']);
  }
  if(process.env.INITIAL_ADMIN_PASSWORD) {
    const hash = await hashPassword(process.env.INITIAL_ADMIN_PASSWORD);
    await pool.query("UPDATE cloud_users SET password_hash=$1,active=true WHERE username='ofer' AND password_hash IS NULL",[hash]);
  }
}
module.exports = {hashPassword,verifyPassword,digest,initialize};
