export interface ShowcaseAuthResponse {
  readonly status: number;
  readonly body: unknown;
  readonly setCookie?: string;
}
export type ShowcaseAuthApi = (method: string, path: string, body: unknown, cookie?: string) => Promise<ShowcaseAuthResponse>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function sessionCookie(response: ShowcaseAuthResponse): string {
  const match = response.setCookie?.match(/(?:^|,\s*)(oantuti_session=[a-f0-9]{64})/i);
  if (!match) throw new Error('authentication response did not set a valid product session cookie');
  return match[1];
}

export async function authenticateShowcaseStudent(options: {
  readonly api: ShowcaseAuthApi;
  readonly username: string;
  readonly password: string;
  readonly previousPassword?: string;
  readonly newPassword: () => string;
  readonly savePasswordIntent?: (newPassword: string, oldPassword: string) => Promise<void>;
  readonly savePassword: (password: string) => Promise<void>;
}): Promise<{ readonly cookie: string; readonly password: string }> {
  let currentPassword=options.password;
  let login=await options.api('POST','/api/v2/auth/login',{username:options.username,password:currentPassword});
  if((login.status<200||login.status>=300)&&options.previousPassword){
    currentPassword=options.previousPassword;
    login=await options.api('POST','/api/v2/auth/login',{username:options.username,password:currentPassword});
  }
  if(login.status<200||login.status>=300)throw new Error(`student login failed for ${options.username} with HTTP ${login.status}`);
  const loginCookie=sessionCookie(login);const identity=record(login.body);
  if(identity?.scope==='FULL'){
    if(options.previousPassword)await options.savePassword(options.password);
    return{cookie:loginCookie,password:options.password};
  }
  if(identity?.scope!=='PASSWORD_CHANGE_ONLY')throw new Error(`unexpected login scope for ${options.username}`);
  const replacement=options.previousPassword?options.password:options.newPassword();
  if(replacement.length<12||replacement.length>128)throw new Error('generated showcase password is outside product policy');
  await options.savePasswordIntent?.(replacement,currentPassword);
  const changed=await options.api('POST','/api/v2/auth/change-password',{oldPassword:currentPassword,newPassword:replacement},loginCookie);
  if(changed.status<200||changed.status>=300)throw new Error(`first password change failed for ${options.username} with HTTP ${changed.status}`);
  const fullCookie=sessionCookie(changed);
  if(record(changed.body)?.scope!=='FULL')throw new Error(`password change did not return a FULL session for ${options.username}`);
  await options.savePassword(replacement);
  return{cookie:fullCookie,password:replacement};
}
