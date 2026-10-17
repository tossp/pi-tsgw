import json
import shlex
import subprocess
import sys

# 此脚本只有程序与公开对象名，不含密钥。凭据仅在子进程管道和内存中传递。
print(json.dumps({'result': 'archive_only', 'instruction': '只读源码归档，不提供供应执行入口；包括 --run 在内均不运行，重新供应须另行授权并先核验状态'}))
raise SystemExit(0)

WORKSPACE = '236885722236035072'
PHASE = 'start'
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
WRITER = r'''
import json,os,stat,subprocess,sys
from pathlib import Path
try:
 data=json.load(sys.stdin)
 pid=subprocess.check_output(['systemctl','--user','show','pi-web.service','-p','MainPID','--value'],text=True).strip()
 assert pid!='0','host_not_running'
 raw=dict(x.split('=',1) for x in Path('/proc/'+pid+'/environ').read_bytes().decode().split('\0') if x.startswith(('HOME=','PI_CODING_AGENT_DIR=')))
 env=os.environ.copy()
 for key in ('HOME','PI_CODING_AGENT_DIR'):
  if key in raw:env[key]=raw[key]
  else:env.pop(key,None)
 cwd=subprocess.check_output(['systemctl','--user','show','pi-web.service','-p','WorkingDirectory','--value'],text=True).strip()
 sdk=str(Path(cwd)/'node_modules/@earendil-works/pi-coding-agent/dist/index.js')
 js='const {getAgentDir}=await import(process.argv[1]);console.log(getAgentDir())'
 agent_dir=Path(subprocess.check_output(['node','--input-type=module','-e',js,sdk],env=env,text=True).strip())
 assert agent_dir.is_absolute(),'invalid_agent_dir'
 secret_dir=agent_dir/'.secrets'
 if not secret_dir.exists():secret_dir.mkdir(mode=0o700)
 dfd=os.open(secret_dir,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  st=os.fstat(dfd)
  assert st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o700,'unsafe_secret_directory'
  token=data['token']
  assert isinstance(token,str) and token.startswith('at_live_') and '\n' not in token and '\r' not in token,'invalid_agent_token'
  fd=os.open('relaycast.key',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dfd)
  with os.fdopen(fd,'w') as f:
   f.write(token+'\n');f.flush();os.fsync(f.fileno())
  os.fsync(dfd)
  st=os.stat('relaycast.key',dir_fd=dfd,follow_symlinks=False)
  print(json.dumps({'saved':True,'path':str(secret_dir/'relaycast.key'),'mode':oct(stat.S_IMODE(st.st_mode)),'uid':st.st_uid}))
 finally:os.close(dfd)
except Exception as e:
 print(json.dumps({'saved':False,'error_type':type(e).__name__}));sys.exit(1)
'''

def parse_response(text):
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        raise RuntimeError('invalid_captured_response') from None


def remote_json(code):
    result = subprocess.run(SSH + ['scnet', 'cd /ts/relaycast && python3 -'], input=code, text=True, capture_output=True, timeout=35)
    if result.returncode:
        raise RuntimeError('scnet_operation_failed_no_retry')
    parsed = parse_response(result.stdout)
    if not parsed.get('ok'):
        raise RuntimeError('scnet_api_failed_no_retry_' + str(parsed.get('status', 'unknown')))
    return parsed['data']


def create(path, body):
    # 管理 key 仅在 scnet 的 Python 进程内读取和消费。
    return remote_json(r'''
import json,urllib.request,urllib.error
from pathlib import Path
try:
 creds=json.loads(Path('credentials/workspace.json').read_text())
 assert creds['workspace_id']==''' + repr(WORKSPACE) + r'''
 body=''' + repr(body) + r'''
 req=urllib.request.Request('http://127.0.0.1:8787/v1/''' + path + r'''',data=json.dumps(body).encode(),method='POST',headers={'Authorization':'Bearer '+creds['api_key'],'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=20) as resp:result=json.load(resp)
 print(json.dumps(result))
except urllib.error.HTTPError as e:print(json.dumps({'ok':False,'status':e.code}))
except Exception as e:print(json.dumps({'ok':False,'status':type(e).__name__}))
''')


def persist(token, host=None):
    command = ['python3', '-c', WRITER] if host is None else SSH + [host, 'python3 -c ' + shlex.quote(WRITER)]
    result = subprocess.run(command, input=json.dumps({'token': token}), text=True, capture_output=True, timeout=25)
    if result.returncode:
        raise RuntimeError('key_write_failed_no_retry')
    parsed = parse_response(result.stdout)
    if not parsed.get('saved'):
        raise RuntimeError('key_not_saved_no_retry')
    return parsed

try:
    PHASE = 'create_discovery_channel'
    channel = create('channels', {'name': 'pi-sessions', 'topic': 'Pi 会话发现目录，仅公告元数据，不包含聊天正文', 'metadata': {'integration': 'pi-tsgw-communication', 'version': 1}})
    assert channel['name'] == 'pi-sessions'
    print(json.dumps({'phase': PHASE, 'name': channel['name'], 'id': channel['id']}), flush=True)
    for name, host in [('pi-claw', None), ('pi-hqdev', 'ts@hq-dev')]:
        PHASE = 'create_' + name
        agent = create('agents', {'name': name, 'auto_join_general': False, 'metadata': {'integration': 'pi-tsgw-communication', 'version': 1, 'role': 'device'}})
        assert agent['name'] == name and agent['workspace_id'] == WORKSPACE
        print(json.dumps({'phase': PHASE, 'name': name, 'id': agent['id']}), flush=True)
        PHASE = 'persist_' + name
        saved = persist(agent['token'], host)
        agent.pop('token', None)
        print(json.dumps({'phase': PHASE, **saved}), flush=True)
    print(json.dumps({'result': 'provisioned', 'agents': 2, 'channels': 1, 'settings_changed': False}))
except Exception as e:
    print(json.dumps({'result': 'stopped', 'phase': PHASE, 'error_type': type(e).__name__, 'detail': str(e) if isinstance(e, RuntimeError) else 'validation_failed', 'automatic_retry': False}), flush=True)
    sys.exit(1)
