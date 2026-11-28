async function initialize(pool){
 await pool.query("CREATE TABLE IF NOT EXISTS cloud_task_state (id integer PRIMARY KEY CHECK(id=1), revision bigint NOT NULL DEFAULT 0, data jsonb NOT NULL DEFAULT '{\"definitions\":[],\"tasks\":[]}', updated_by text REFERENCES cloud_users(username), updated_at timestamptz NOT NULL DEFAULT now()); INSERT INTO cloud_task_state(id) VALUES(1) ON CONFLICT DO NOTHING;");
}
function valid(data){
 const str=(x,n=2000)=>typeof x==='string'&&x.length<=n;
 const date=x=>str(x,40)&&Number.isFinite(Date.parse(x));
 const week=x=>str(x,10)&&/^\d{4}-\d{2}-\d{2}$/.test(x);
 const workflows=data?.workflows;
 if(workflows!==undefined){
  if(!workflows||typeof workflows!=='object'||Array.isArray(workflows)||Object.keys(workflows).length>520)return false;
  for(const [key,state] of Object.entries(workflows)){
   if(!/^purple:\d{4}-\d{2}-\d{2}$/.test(key)||new Date(key.slice(7)+'T12:00:00Z').getUTCDay()!==0||!state||!Array.isArray(state.completed)||state.completed.length!==5||!state.completed.every(x=>x===null||date(x))||!(state.approvedAt===null||date(state.approvedAt)))return false;
   if(state.approvedAt&&!state.completed[1])return false;
   if(state.completed[2]&&!state.approvedAt)return false;
   if(state.completed.some((x,i)=>x&&i>0&&!state.completed[i-1]))return false;
  }
 }
 return data&&Array.isArray(data.definitions)&&Array.isArray(data.tasks)&&data.definitions.length<=500&&data.tasks.length<=5000&&new Set(data.definitions.map(x=>x?.id)).size===data.definitions.length&&new Set(data.tasks.map(x=>x?.id)).size===data.tasks.length&&data.definitions.every(d=>d&&str(d.id,100)&&str(d.name,200)&&str(d.project,100)&&str(d.groupId,200)&&str(d.instructions,10000)&&str(d.body,10000)&&str(d.subject,500)&&Number.isInteger(d.durationHours)&&d.durationHours>=1&&d.durationHours<=8760&&(d.deadlineDay==null||(Number.isInteger(d.deadlineDay)&&d.deadlineDay>=0&&d.deadlineDay<=6&&/^([01]\d|2[0-3]):[0-5]\d$/.test(d.deadlineTime)))&&(d.weekly!==true||(Number.isInteger(d.deadlineDay)&&week(d.repeatFrom)&&new Date(d.repeatFrom+'T12:00:00Z').getUTCDay()===0)))&&data.tasks.every(t=>t&&str(t.id,100)&&str(t.definitionId,100)&&str(t.name,200)&&str(t.project,100)&&str(t.groupId,200)&&str(t.instructions,10000)&&str(t.body,10000)&&str(t.subject,500)&&week(t.weekStart)&&date(t.receivedAt)&&date(t.dueAt)&&Date.parse(t.dueAt)>Date.parse(t.receivedAt)&&(!t.completedAt||date(t.completedAt)));
}

const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function local(d){const p=Object.fromEntries(fmt.formatToParts(d).map(x=>[x.type,x.value]));return p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute}
function plus(d,n){const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)}
function iso(v){let t=Date.parse(v+'Z');for(let i=0;i<3;i++)t+=Date.parse(v+'Z')-Date.parse(local(new Date(t))+'Z');return new Date(t).toISOString()}
function generate(data,now=new Date()){
 const today=local(now).slice(0,10),sunday=plus(today,-new Date(today+'T12:00:00Z').getUTCDay());let changed=false;
 for(const d of data.definitions){if(!d.weekly||!Number.isInteger(d.deadlineDay)||!d.deadlineTime)continue;
 const start=d.repeatFrom||sunday;for(let cycle=start,i=0;cycle<=sunday&&i<520;cycle=plus(cycle,7),i++){
 const weekStart=plus(cycle,7);if(data.tasks.some(t=>t.definitionId===d.id&&t.weekStart===weekStart)||data.tasks.length>=5000)continue;
 const dueAt=iso(plus(cycle,d.deadlineDay)+'T'+d.deadlineTime),receivedAt=iso(cycle+'T00:00');
 if(Date.parse(dueAt)<=Date.parse(receivedAt))continue;
 data.tasks.push({...d,id:require('node:crypto').randomUUID(),definitionId:d.id,weekStart,receivedAt,dueAt,completedAt:null});changed=true;
 }}return changed;
}
function register(app,pool,user){
 app.get('/api/tasks',async(req,res)=>{if(!await user(req))return res.sendStatus(401);const client=await pool.connect();try{await client.query('BEGIN');const state=(await client.query('SELECT revision::text,data FROM cloud_task_state WHERE id=1 FOR UPDATE')).rows[0];if(generate(state.data)){state.revision=(await client.query('UPDATE cloud_task_state SET data=$1::jsonb,revision=revision+1,updated_at=now() WHERE id=1 RETURNING revision::text',[JSON.stringify(state.data)])).rows[0].revision}await client.query('COMMIT');res.json(state)}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}});
 app.put('/api/tasks',async(req,res)=>{const u=await user(req);if(!u)return res.sendStatus(401);if(req.get('origin')!=='https://elia-copilot.onrender.com')return res.sendStatus(403);const {revision,data}=req.body||{};if(typeof revision!=='string'||!/^\d{1,18}$/.test(revision)||!valid(data))return res.sendStatus(400);const {rows}=await pool.query('UPDATE cloud_task_state SET data=$1::jsonb,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=1 AND revision=$3 RETURNING revision::text',[JSON.stringify(data),u.username,revision]);if(!rows.length)return res.status(409).json({error:'revision_conflict'});res.json(rows[0])});
}
module.exports={initialize,register};