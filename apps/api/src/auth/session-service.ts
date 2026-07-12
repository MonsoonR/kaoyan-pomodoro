import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { LOCK_DURATION_MS, LOCK_FAILURES, SESSION_MAX_AGE_SECONDS } from './constants';
import { parseDevice } from './device';
import { verifyPassword, hashPassword, type PasswordOptions } from './password';
import { hashSessionToken } from './tokens';

type UserRow = { id:string; username:string; password_hash:string; failed_login_count:number; locked_until:number|null };
export class AuthFailure extends Error { code='INVALID_CREDENTIALS'; }
export interface Services { sqlite: Database.Database; now:()=>Date; token:()=>string; passwordOptions:PasswordOptions }

export async function login(s: Services, username:string, password:string, userAgent:string) {
  const now=s.now().getTime(); const user=s.sqlite.prepare('select id,username,password_hash,failed_login_count,locked_until from users where username=?').get(username) as UserRow|undefined;
  if (user?.locked_until && user.locked_until>now) throw new AuthFailure('Invalid username or password');
  const valid=user ? await verifyPassword(user.password_hash,password) : false;
  if (!user || !valid) {
    if (user) s.sqlite.transaction(()=>{ s.sqlite.prepare(`update users set failed_login_count=failed_login_count+1,last_failed_login_at=?,locked_until=case when failed_login_count+1>=? then ? else locked_until end where id=?`).run(now,LOCK_FAILURES,now+LOCK_DURATION_MS,user.id); })();
    throw new AuthFailure('Invalid username or password');
  }
  const device=parseDevice(userAgent); const deviceId=randomUUID(); const sessionId=randomUUID(); const token=s.token(); const expiresAt=now+SESSION_MAX_AGE_SECONDS*1000;
  s.sqlite.transaction(()=>{
    s.sqlite.prepare('insert into devices (id,user_id,name,browser,operating_system,last_active_at,created_at,updated_at) values (?,?,?,?,?,?,?,?)').run(deviceId,user.id,device.name,device.browser,device.operatingSystem,now,now,now);
    s.sqlite.prepare('insert into sessions (id,user_id,device_id,token_hash,expires_at,last_seen_at,created_at) values (?,?,?,?,?,?,?)').run(sessionId,user.id,deviceId,hashSessionToken(token),expiresAt,now,now);
    s.sqlite.prepare('update users set failed_login_count=0,last_failed_login_at=null,locked_until=null,updated_at=? where id=?').run(now,user.id);
  })();
  return { token, user:{id:user.id,username:user.username}, deviceId, deviceName:device.name, expiresAt:new Date(expiresAt) };
}

export function authenticate(s: Services, token?:string) {
  if(!token) return null; const now=s.now().getTime();
  const row=s.sqlite.prepare(`select sessions.id session_id,sessions.user_id,sessions.device_id,sessions.expires_at,sessions.last_seen_at,users.username,devices.name device_name from sessions join users on users.id=sessions.user_id join devices on devices.id=sessions.device_id where sessions.token_hash=? and sessions.revoked_at is null and sessions.expires_at>?`).get(hashSessionToken(token),now) as any;
  if(!row) return null;
  if(now-row.last_seen_at>300000) s.sqlite.transaction(()=>{s.sqlite.prepare('update sessions set last_seen_at=? where id=?').run(now,row.session_id);s.sqlite.prepare('update devices set last_active_at=?,updated_at=? where id=?').run(now,now,row.device_id);})();
  return row;
}

export async function changePassword(s:Services, auth:any, current:string,next:string) {
  const user=s.sqlite.prepare('select password_hash from users where id=?').get(auth.user_id) as {password_hash:string};
  if(!await verifyPassword(user.password_hash,current)) throw new AuthFailure('Current password is incorrect');
  const hash=await hashPassword(next,s.passwordOptions); const now=s.now().getTime();
  s.sqlite.transaction(()=>{s.sqlite.prepare('update users set password_hash=?,password_changed_at=?,updated_at=? where id=?').run(hash,now,now,auth.user_id);s.sqlite.prepare('update sessions set revoked_at=? where user_id=? and id<>? and revoked_at is null').run(now,auth.user_id,auth.session_id);})();
}
