import { describe, expect, it } from 'vitest';
import { authenticateShowcaseStudent, type ShowcaseAuthApi } from '../deploy/linux/demo-showcase-auth.js';

const cookie='oantuti_session='+'a'.repeat(64);

describe('showcase student authentication',()=>{
  it('uses the product first-password-change flow and persists the new password',async()=>{
    const calls:{method:string;path:string;body?:unknown;cookie?:string}[]=[];let saved='';
    const api:ShowcaseAuthApi=async(method,path,body,session)=>{calls.push({method,path,body,cookie:session});if(path.endsWith('/login'))return{status:200,body:{scope:'PASSWORD_CHANGE_ONLY'},setCookie:cookie};if(path.endsWith('/change-password'))return{status:200,body:{scope:'FULL'},setCookie:cookie};throw new Error(path);};
    const result=await authenticateShowcaseStudent({api,username:'showcase_01a',password:'issued',newPassword:()=> 'replacement-secret',savePassword:async(value)=>{saved=value;}});
    expect(result).toEqual({cookie,password:'replacement-secret'});expect(saved).toBe('replacement-secret');
    expect(calls.map(({path})=>path)).toEqual(['/api/v2/auth/login','/api/v2/auth/change-password']);
    expect(calls[1].cookie).toBe(cookie);expect(calls[1].body).toEqual({oldPassword:'issued',newPassword:'replacement-secret'});
  });

  it('refuses a login response without a valid product session cookie',async()=>{
    const api:ShowcaseAuthApi=async()=>({status:200,body:{scope:'FULL'}});
    await expect(authenticateShowcaseStudent({api,username:'showcase_01a',password:'secret',newPassword:()=> 'unused',savePassword:async()=>undefined})).rejects.toThrow(/session cookie/);
  });
  it('recovers an interrupted first-password change using the durable previous password',async()=>{
    let stored:{password:string;previousPassword?:string}={password:'issued'};let failChange=true;
    const api:ShowcaseAuthApi=async(method,path,body)=>{
      const password=body&&typeof body==='object'&&'password' in body&&typeof body.password==='string'?body.password:undefined;
      if(path.endsWith('/login'))return password===stored.password?{status:200,body:{scope:'PASSWORD_CHANGE_ONLY'},setCookie:cookie}:{status:401,body:{}};
      if(path.endsWith('/change-password')){if(failChange){failChange=false;return{status:503,body:{}};}return{status:200,body:{scope:'FULL'},setCookie:cookie};}
      throw new Error(path);
    };
    await expect(authenticateShowcaseStudent({api,username:'showcase_01a',password:stored.password,newPassword:()=> 'replacement-secret',savePasswordIntent:async(password,oldPassword)=>{stored={password,previousPassword:oldPassword};},savePassword:async(password)=>{stored={password};}})).rejects.toThrow(/password change failed/);
    const result=await authenticateShowcaseStudent({api,username:'showcase_01a',password:stored.password,previousPassword:stored.previousPassword,newPassword:()=> 'unused-password',savePasswordIntent:async(password,oldPassword)=>{stored={password,previousPassword:oldPassword};},savePassword:async(password)=>{stored={password};}});
    expect(result.password).toBe('replacement-secret');expect(stored).toEqual({password:'replacement-secret'});
  });
});
