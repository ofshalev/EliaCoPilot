async function initialize(pool){
 await pool.query("CREATE TABLE IF NOT EXISTS cloud_contacts (id integer PRIMARY KEY CHECK(id=1), revision bigint NOT NULL DEFAULT 0, data jsonb, updated_by text REFERENCES cloud_users(username), updated_at timestamptz NOT NULL DEFAULT now()); INSERT INTO cloud_contacts(id) VALUES(1) ON CONFLICT DO NOTHING;");
}
function valid(d){
 if(!d||d.version!==2||!Array.isArray(d.people)||!Array.isArray(d.groups)||!Array.isArray(d.affiliations)||!d.groups.length||d.people.length>20000||d.groups.length>2000)return false;
 const str=x=>typeof x==='string'&&x.length<=2000;
 if(!d.people.every(p=>p&&[p.id,p.name,p.email,p.affiliation].every(str))||!d.affiliations.every(str))return false;
 const ids=new Set(d.people.map(p=>p.id));
 return ids.size===d.people.length&&new Set(d.groups.map(g=>g?.id)).size===d.groups.length&&d.groups.every(g=>g&&str(g.id)&&str(g.name)&&[g.to,g.cc].every(a=>Array.isArray(a)&&a.every(x=>ids.has(x))));
}
function register(app,pool,user){
 app.get('/api/contacts',async(req,res)=>{
 if(!await user(req))return res.sendStatus(401);
 res.json((await pool.query('SELECT revision::text,data FROM cloud_contacts WHERE id=1')).rows[0]);
 });
 app.put('/api/contacts',async(req,res)=>{
 const u=await user(req);if(!u)return res.sendStatus(401);
 if(req.get('origin')!=='https://elia-copilot.onrender.com')return res.sendStatus(403);
 const {revision,data}=req.body||{};
 if(typeof revision!=='string'||!/^\d{1,18}$/.test(revision)||!valid(data))return res.sendStatus(400);
 const {rows}=await pool.query('UPDATE cloud_contacts SET data=$1::jsonb,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=1 AND revision=$3 RETURNING revision::text',[JSON.stringify(data),u.username,revision]);
 if(!rows.length)return res.status(409).json({error:'revision_conflict'});
 res.json(rows[0]);
 });
}
module.exports={initialize,register};
