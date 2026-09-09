"""Read Arga's catalog through the locally configured MCP connection; never print credentials."""
import json
from pathlib import Path
import tomllib
import urllib.request
import urllib.error

config = tomllib.loads((Path.home() / '.codex/config.toml').read_text())['mcp_servers']['arga-context']
headers = {**config['http_headers'], 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

opener = urllib.request.build_opener(NoRedirect)

def rpc(method, params=None, request_id=None):
    body = {'jsonrpc': '2.0', 'method': method}
    if params is not None:
        body['params'] = params
    if request_id is not None:
        body['id'] = request_id
    request = urllib.request.Request(config['url'], json.dumps(body).encode(), headers, method='POST')
    with opener.open(request, timeout=30) as response:
        if response.headers.get('Mcp-Session-Id'):
            headers['Mcp-Session-Id'] = response.headers['Mcp-Session-Id']
        if request_id is None or response.status == 202:
            return {}
        if 'text/event-stream' in response.headers.get('Content-Type', ''):
            for line in response:
                if line.startswith(b'data:'):
                    data = json.loads(line[5:])
                    if data.get('id') == request_id:
                        return data
            raise RuntimeError('Missing MCP response')
        return json.loads(response.read())

try:
    result = rpc('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'aftercare', 'version': '0.1.0'}}, 1)
    headers['MCP-Protocol-Version'] = result['result']['protocolVersion']
    rpc('notifications/initialized')
    catalog = rpc('tools/call', {'name': 'get_twin_catalog', 'arguments': {}}, 2)
    if 'error' in catalog or catalog.get('result', {}).get('isError'):
        raise RuntimeError('Arga returned a catalog error')
    output = Path(__file__).resolve().parents[1] / '.data/arga-catalog.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(catalog['result'], indent=2))
    # Catalog is public provider metadata, not a provisioned run with credentials.
    for block in catalog['result'].get('content', []):
        if block.get('type') == 'text':
            print(block['text'])
    print('Catalog saved. No environments provisioned.')
except urllib.error.HTTPError as error:
    raise SystemExit(f'Arga returned HTTP {error.code}; response omitted.') from None
except urllib.error.URLError:
    raise SystemExit('Could not reach Arga.') from None
