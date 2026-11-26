async function initialize(pool){
 await pool.query("CREATE TABLE IF NOT EXISTS cloud_event_state (id integer PRIMARY KEY CHECK(id=1), revision bigint NOT NULL DEFAULT 0, events jsonb NOT NULL DEFAULT '[]', updated_by text REFERENCES cloud_users(username), updated_at timestamptz NOT NULL DEFAULT now()); INSERT INTO cloud_event_state(id) VALUES(1) ON CONFLICT DO NOTHING;");
}
function register(app,pool,user){
 app.get('/api/events',async(req,res)=>{
  if(!await user(req))return res.sendStatus(401);
  const {rows}=await pool.query('SELECT revision::text,events FROM cloud_event_state WHERE id=1');
  res.json(rows[0]);
 });
 app.put('/api/events',async(req,res)=>{
  const u=await user(req);if(!u)return res.sendStatus(401);
  if(req.get('origin')!=='https://elia-copilot.onrender.com')return res.sendStatus(403);
  const {revision,events}=req.body||{};
  if(typeof revision!=='string'||!/^\d{1,18}$/.test(revision)||!Array.isArray(events)||events.length>20000||events.some(e=>!e||typeof e.id!=='string'||!e.id||typeof e.eventTitle!=='string')||new Set(events.map(e=>e.id)).size!==events.length)return res.sendStatus(400);
  const {rows}=await pool.query('UPDATE cloud_event_state SET events=$1::jsonb,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=1 AND revision=$3 RETURNING revision::text',[JSON.stringify(events),u.username,revision]);
  if(!rows.length)return res.status(409).json({error:'revision_conflict'});
  res.json(rows[0]);
 });
}
module.exports={initialize,register};
