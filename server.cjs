const express = require('express');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const auth = require('./cloud-auth.cjs');
const cloudContacts=require('./cloud-contacts.cjs');
const cloudEvents=require('./cloud-events.cjs');
const path=require('node:path');
const app = express();
app.disable('x-powered-by');
const pool = new Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:3000,query_timeout:5000});
pool.on('error',()=>console.error('Database pool error'));
app.use((req,res,next)=>{res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('X-Frame-Options','DENY');res.set('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");next();});
app.use(express.json({limit:'8mb'}));
app.use(express.urlencoded({extended:false,limit:'8kb'}));
const origin='https://elia-copilot.onrender.com';
app.use((req,res,next)=>{if(req.method==='POST' && req.get('origin')!==origin)return res.sendStatus(403);next();});
const page=(body)=>'<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Elia CoPilot</title><style>body{font-family:Arial;background:#eef2f6;display:grid;place-items:center;min-height:95vh}main{background:white;padding:32px;border-radius:16px;width:min(340px,80vw);box-shadow:0 4px 24px #0001}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;border:1px solid #ccd4df;border-radius:8px;font:inherit}button{background:#234b73;color:white;cursor:pointer}h1{direction:ltr;text-align:center}</style><main><h1>Elia CoPilot</h1>'+body+'</main></html>';
const login=(error='')=>page('<h2>כניסה למערכת</h2>'+error+'<form method="post" action="/login"><label>שם משתמש<input name="username" autocomplete="username" required maxlength="32" dir="ltr"></label><label>סיסמה<input type="password" name="password" autocomplete="current-password" required maxlength="128" dir="ltr"></label><button>כניסה</button></form>');
const token=req=>(req.headers.cookie||'').match(/(?:^|;\s*)elia_session=([a-f0-9]{64})(?:;|$)/)?.[1];
async function user(req){const t=token(req);if(!t)return null;return (await pool.query('SELECT u.username,u.role FROM cloud_sessions s JOIN cloud_users u USING(username) WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active',[auth.digest(t)])).rows[0];}
app.get('/health',(req,res)=>res.json({status:'ok'}));
app.get('/ready',async(req,res)=>{try{await pool.query('SELECT 1');res.json({status:'ready'});}catch{res.status(503).json({status:'not_ready'});}});
app.get('/',async(req,res)=>{if(await user(req))return res.redirect('/events.html');return res.send(login());});
app.get('/account',async(req,res)=>{const u=await user(req);if(!u)return res.send(login());res.send(page('<h2>שלום, '+u.username+'</h2>'+(u.role==='admin'?'<p><a href="/admin/users">ניהול משתמשים</a></p>':'')+'<p>התחברת בהצלחה. <a href="/events.html">חזרה לאירועים</a></p><form method="post" action="/logout"><button>יציאה</button></form>'));});
let attempts=0,windowStart=Date.now();
app.post('/login',async(req,res)=>{if(Date.now()-windowStart>60000){attempts=0;windowStart=Date.now();}if(++attempts>20)return res.status(429).send(login('<p>נא לנסות שוב בעוד דקה.</p>'));const name=String(req.body.username||'').trim().toLowerCase();const password=req.body.password;const u=(await pool.query('SELECT * FROM cloud_users WHERE username=$1 AND active',[name])).rows[0];if(!u||!await auth.verifyPassword(password,u.password_hash))return res.status(401).send(login('<p>שם משתמש או סיסמה שגויים.</p>'));const t=crypto.randomBytes(32).toString('hex');await pool.query("DELETE FROM cloud_sessions WHERE expires_at<=now()");await pool.query("INSERT INTO cloud_sessions VALUES($1,$2,now()+interval '12 hours')",[auth.digest(t),name]);res.cookie('elia_session',t,{httpOnly:true,secure:true,sameSite:'strict',maxAge:43200000,path:'/'});res.redirect(303,'/');});
app.post('/logout',async(req,res)=>{const t=token(req);if(t)await pool.query('DELETE FROM cloud_sessions WHERE token_hash=$1',[auth.digest(t)]);res.clearCookie('elia_session',{httpOnly:true,secure:true,sameSite:'strict',path:'/'});res.redirect(303,'/');});
async function adminOnly(req,res,next){const u=await user(req);if(!u||u.role!=='admin')return res.sendStatus(403);next();}
app.get('/admin/users',adminOnly,async(req,res)=>{
 const rows=(await pool.query("SELECT username,role,active FROM cloud_users WHERE username IN ('ofer','roni','ofri','rotem') ORDER BY username")).rows;
 res.send(page('<h2>ניהול משתמשים</h2><p><a href="/">חזרה</a></p>'+rows.map(u=>'<section style="border-top:1px solid #ccd4df;padding:12px 0"><strong>'+u.username+'</strong> — '+(u.role==='admin'?'מנהל':'משתמש')+' — '+(u.active?'פעיל':'לא פעיל')+(u.username==='ofer'?'': '<form method="post" action="/admin/users/password"><input type="hidden" name="username" value="'+u.username+'"><label>סיסמה חדשה<input type="password" name="password" minlength="12" maxlength="128" required autocomplete="new-password"></label><button>הגדרת סיסמה והפעלה</button></form><form method="post" action="/admin/users/disable"><input type="hidden" name="username" value="'+u.username+'"><button>השבתת חשבון</button></form>')+'</section>').join('')));
});
async function changeAccount(req,res,disable){
 const name=req.body.username;
 if(!['roni','ofri','rotem'].includes(name))return res.sendStatus(400);
 if(!disable&&(typeof req.body.password!=='string'||req.body.password.length<12||req.body.password.length>128))return res.status(400).send('Password must contain 12–128 characters');
 const hash=disable?null:await auth.hashPassword(req.body.password);
 const client=await pool.connect();try{await client.query('BEGIN');if(disable)await client.query("UPDATE cloud_users SET active=false WHERE username=$1 AND role='user'",[name]);else await client.query("UPDATE cloud_users SET password_hash=$1,active=true WHERE username=$2 AND role='user'",[hash,name]);await client.query('DELETE FROM cloud_sessions WHERE username=$1',[name]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}res.redirect(303,'/admin/users');
}
app.post('/admin/users/password',adminOnly,(req,res)=>changeAccount(req,res,false));
app.post('/admin/users/disable',adminOnly,(req,res)=>changeAccount(req,res,true));
cloudEvents.register(app,pool,user);
cloudContacts.register(app,pool,user);
app.get(['/events.html','/segments.html','/contacts.html','/mail-generator.html','/word-generator.html','/work-importer.html'],async(req,res)=>{
 if(!await user(req))return res.redirect('/');
 res.set('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'"+(req.path==='/work-importer.html'?' https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js':'')+"; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
 res.sendFile(path.join(__dirname,req.path.slice(1)));
});
app.use((err,req,res,next)=>{console.error('Request failed');res.status(500).send('Service error');});
auth.initialize(pool).then(()=>cloudEvents.initialize(pool)).then(()=>cloudContacts.initialize(pool)).then(()=>app.listen(Number(process.env.PORT||3000),'0.0.0.0')).catch(()=>{console.error('Database initialization failed');process.exit(1);});
