import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { DatabaseConnection } from './db/client';
import { openDatabase } from './db/client';
import { migrateDatabase } from './db/migrate';
import { installOriginGuard } from './security/origin-guard';
import { authRoutes } from './routes/auth';
import { deviceRoutes } from './routes/devices';
import { generateSessionToken } from './auth/tokens';
import { PRODUCTION_PASSWORD_OPTIONS, type PasswordOptions } from './auth/password';

export interface AppOptions { database?:DatabaseConnection; appOrigin:string; now?:()=>Date; generateToken?:()=>string; passwordOptions?:PasswordOptions; loginRateLimit?:{max:number;timeWindow:string|number}; logger?:boolean }
export async function createApp(options:AppOptions){
  const app=Fastify({logger:options.logger??true}); const owned=!options.database; const connection=options.database??openDatabase(':memory:'); if(owned)migrateDatabase(connection.db);
  await app.register(cookie); await app.register(rateLimit,{global:false,max:options.loginRateLimit?.max??10,timeWindow:options.loginRateLimit?.timeWindow??'1 minute',errorResponseBuilder:()=>({statusCode:429,code:'RATE_LIMITED',error:'Too Many Requests',message:'Too many login attempts'})});
  installOriginGuard(app,options.appOrigin);
  const services={sqlite:connection.sqlite,now:options.now??(()=>new Date()),token:options.generateToken??generateSessionToken,passwordOptions:options.passwordOptions??PRODUCTION_PASSWORD_OPTIONS};
  await authRoutes(app,services,options.loginRateLimit??{max:10,timeWindow:'1 minute'}); await deviceRoutes(app,services);
  app.setErrorHandler((error,_request,reply)=>{if(error instanceof ZodError)return reply.code(400).send({code:'VALIDATION_ERROR',message:'Invalid request'});if(typeof error==='object'&&error!==null&&'statusCode' in error&&error.statusCode===429)return reply.code(429).send({code:'RATE_LIMITED',message:'Too many login attempts'});app.log.error(error);return reply.code(500).send({code:'INTERNAL_ERROR',message:'Internal server error'});});
  if(owned)app.addHook('onClose',async()=>connection.close()); return app;
}
