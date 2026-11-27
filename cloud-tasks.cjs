async function initialize(pool){
 await pool.query("CREATE TABLE IF NOT EXISTS cloud_task_state (id integer PRIMARY KEY CHECK(id=1), revision bigint NOT NULL DEFAULT 0, data jsonb NOT NULL DEFAULT '{\"definitions\":[],\"tasks\":[]}', updated_by text REFERENCES cloud_users(username), updated_at timestamptz NOT NULL DEFAULT now()); INSERT INTO cloud_task_state(id) VALUES(1) ON CONFLICT DO NOTHING;");
}
function valid(data){
 const str=(x,n=2000)=>typeof x==='string'&&x.length<=n;
 const date=x=>str(x,40)&&Number.isFinite(Date.parse(x));
 const week=x=>str(x,10)&&/^\d{4}-\d{2}-\d{2}$/.test(x);
 return data&&Array.isArray(data.definitions)&&Array.isArray(data.tasks)&&data.definitions.length<=500&&data.tasks.length<=5000&&new Set(data.definitions.map(x=>x?.id)).size===data.definitions.length&&new Set(data.tasks.map(x=>x?.id)).size===data.tasks.length&&data.definitions.every(d=>d&&str(d.id,100)&&str(d.name,200)&&str(d.project,100)&&str(d.groupId,200)&&str(d.instructions,10000)&&str(d.body,10000)&&str(d.subject,500)&&Number.isInteger(d.durationHours)&&d.durationHours>=1&&d.durationHours<=8760)&&data.tasks.every(t=>t&&str(t.id,100)&&str(t.definitionId,100)&&str(t.name,200)&&str(t.project,100)&&str(t.groupId,200)&&str(t.instructions,10000)&&str(t.body,10000)&&str(t.subject,500)&&week(t.weekStart)&&date(t.receivedAt)&&date(t.dueAt)&&Date.parse(t.dueAt)>Date.parse(t.receivedAt)&&(!t.completedAt||date(t.completedAt)));
}
function register(app,pool,user){
 app.get('/api/tasks',async(req,res)=>{if(!await user(req))return res.sendStatus(401);res.json((await pool.query('SELECT revision::text,data FROM cloud_task_state WHERE id=1')).rows[0])});
 app.put('/api/tasks',async(req,res)=>{const u=await user(req);if(!u)return res.sendStatus(401);if(req.get('origin')!=='https://elia-copilot.onrender.com')return res.sendStatus(403);const {revision,data}=req.body||{};if(typeof revision!=='string'||!/^\d{1,18}$/.test(revision)||!valid(data))return res.sendStatus(400);const {rows}=await pool.query('UPDATE cloud_task_state SET data=$1::jsonb,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=1 AND revision=$3 RETURNING revision::text',[JSON.stringify(data),u.username,revision]);if(!rows.length)return res.status(409).json({error:'revision_conflict'});res.json(rows[0])});
}
module.exports={initialize,register};