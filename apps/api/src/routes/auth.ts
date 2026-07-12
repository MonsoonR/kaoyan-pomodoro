import type { FastifyInstance } from 'fastify';
import { ChangePasswordRequestSchema, LoginRequestSchema } from '@kaoyan/contracts';
import { COOKIE_OPTIONS, SESSION_COOKIE_NAME } from '../auth/constants';
import { AuthFailure, authenticate, changePassword, login, type Services } from '../auth/session-service';

function required(app:FastifyInstance,s:Services){return async (request:any,reply:any)=>{const auth=authenticate(s,request.cookies[SESSION_COOKIE_NAME]);if(!auth)return reply.code(401).send({code:'UNAUTHENTICATED',message:'Authentication required'});request.auth=auth;};}
export async function authRoutes(app:FastifyInstance,s:Services,loginRateLimit:{max:number;timeWindow:string|number}){
  app.post('/api/auth/login',{config:{rateLimit:loginRateLimit}},async(req,reply)=>{try{const body=LoginRequestSchema.parse(req.body);const result=await login(s,body.username,body.password,req.headers['user-agent']??'');reply.setCookie(SESSION_COOKIE_NAME,result.token,COOKIE_OPTIONS);return {user:result.user,deviceId:result.deviceId,deviceName:result.deviceName,expiresAt:result.expiresAt.toISOString()};}catch(error){if(error instanceof AuthFailure)return reply.code(401).send({code:error.code,message:'Invalid username or password'});throw error;}});
  app.get('/api/auth/me',{preHandler:required(app,s)},async(req:any)=>({user:{id:req.auth.user_id,username:req.auth.username},deviceId:req.auth.device_id,deviceName:req.auth.device_name,expiresAt:new Date(req.auth.expires_at).toISOString()}));
  app.post('/api/auth/logout',{preHandler:required(app,s)},async(req:any,reply)=>{s.sqlite.prepare('update sessions set revoked_at=? where id=? and revoked_at is null').run(s.now().getTime(),req.auth.session_id);reply.clearCookie(SESSION_COOKIE_NAME,COOKIE_OPTIONS);return {ok:true};});
  app.post('/api/auth/change-password',{preHandler:required(app,s)},async(req:any,reply)=>{const body=ChangePasswordRequestSchema.parse(req.body);try{await changePassword(s,req.auth,body.currentPassword,body.newPassword);return {ok:true};}catch(e){if(e instanceof AuthFailure)return reply.code(401).send({code:'INVALID_CURRENT_PASSWORD',message:'Current password is incorrect'});throw e;}});
}
