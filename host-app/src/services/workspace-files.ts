// Runs as the unprivileged workspace user. No host directories are mounted.
export const FILES_PORT = 9090;
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
export interface FileEndpoint { port: number; token: string; }

export const FILE_AGENT = String.raw`
import os, json, stat, uuid, hmac
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit, parse_qs

ROOT = '/home/kasm-user'
MAX = 1073741824
TOKEN = os.environ['PB_FILES_TOKEN']
folders = {}
for name in ('Uploads', 'Downloads'):
    path = ROOT + '/' + name
    os.makedirs(path, exist_ok=True)
    folders[name] = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

def filename(value):
    if not value or value in ('.', '..') or len(value.encode('utf-8')) > 220 or any(ord(c) < 32 or c in '/\\' for c in value):
        raise ValueError('Choose a regular file with a shorter filename.')
    return value

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def end_headers(self):
        self.response_started = True
        super().end_headers()
    def log_message(self, *args): pass
    def reply(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True
    def authorized(self):
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
            self.reply(403, {'error': 'Access denied.'})
            return False
        self.connection.settimeout(60)
        return True
    def do_GET(self):
        if not self.authorized(): return
        url = urlsplit(self.path)
        try:
            if url.path == '/health':
                self.reply(200, {'status': 'ok'})
            elif url.path == '/downloads':
                result = []
                fd = folders['Downloads']
                for name in os.listdir(fd):
                    if name.startswith('.pb-') or name.endswith(('.crdownload', '.part', '.tmp')): continue
                    try:
                        filename(name)
                        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                        if stat.S_ISREG(info.st_mode):
                            result.append({'name': name, 'size': info.st_size, 'modified': info.st_mtime})
                    except (OSError, ValueError): continue
                result.sort(key=lambda entry: entry['modified'], reverse=True)
                self.reply(200, {'files': result[:1000]})
            elif url.path == '/download':
                name = filename(parse_qs(url.query).get('name', [''])[0])
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folders['Downloads'])
                with os.fdopen(fd, 'rb') as source:
                    info = os.fstat(source.fileno())
                    if not stat.S_ISREG(info.st_mode): raise ValueError('Only regular files can be downloaded.')
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(info.st_size))
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    remaining = info.st_size
                    while remaining:
                        block = source.read(min(65536, remaining))
                        if not block: break
                        self.wfile.write(block)
                        remaining -= len(block)
                    self.close_connection = True
            else: self.reply(404, {'error': 'Unknown file operation.'})
        except (BrokenPipeError, ConnectionResetError): pass
        except FileNotFoundError: self.reply(404, {'error': 'This download is no longer available.'})
        except (ValueError, OSError):
            if getattr(self, 'response_started', False): self.close_connection = True
            else: self.reply(400, {'error': 'The file is unavailable or its name is invalid.'})
    def do_PUT(self):
        if not self.authorized(): return
        temporary = None
        fd = folders['Uploads']
        try:
            url = urlsplit(self.path)
            if url.path != '/upload':
                self.reply(404, {'error': 'Unknown file operation.'}); return
            name = filename(parse_qs(url.query).get('name', [''])[0])
            size = int(self.headers.get('Content-Length', '-1'))
            if self.headers.get('Transfer-Encoding') or size < 0 or size > MAX:
                self.reply(413, {'error': 'Uploads must be at most 1 GiB.'}); return
            temporary = '.pb-upload-' + uuid.uuid4().hex
            output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            with os.fdopen(output, 'wb') as target:
                remaining = size
                while remaining:
                    block = self.rfile.read(min(65536, remaining))
                    if not block: raise ValueError('Upload interrupted.')
                    target.write(block)
                    remaining -= len(block)
            # Never overwrite an earlier upload or follow an existing symlink.
            stem, extension = os.path.splitext(name)
            chosen = name
            for index in range(10000):
                try:
                    os.link(temporary, chosen, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                    break
                except FileExistsError: chosen = stem + ' (' + str(index + 1) + ')' + extension
            else: raise ValueError('Too many files with this name.')
            self.reply(201, {'name': chosen, 'size': size})
        except (BrokenPipeError, ConnectionResetError): pass
        except (ValueError, OSError): self.reply(400, {'error': 'Upload failed. Check the filename and available workspace storage.'})
        finally:
            if temporary:
                try: os.unlink(temporary, dir_fd=fd)
                except FileNotFoundError: pass

ThreadingHTTPServer(('0.0.0.0', 9090), Handler).serve_forever()
`;
