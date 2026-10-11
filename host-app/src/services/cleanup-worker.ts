import Docker from 'dockerode';

// Detached helper survives a host crash. It can remove only the exact container
// assigned by its parent, and retains no profile data or credentials.
const id = process.argv[2];
if (!/^[a-f0-9]{64}$/.test(id || '')) process.exit(1);
const docker = new Docker({ socketPath: '//./pipe/docker_engine' });
let cleaning = false;
process.on('message', message => {
  if (message === 'removed') process.exit(0);
  if (message === 'cleanup') void cleanup();
});
process.on('disconnect', () => { void cleanup(); });
process.send?.('ready');
async function cleanup(): Promise<void> {
  if (cleaning) return;
  cleaning = true;
  for (;;) {
    try { await docker.getContainer(id).remove({ force: true, v: true }); process.exit(0); }
    catch (error: any) { if (error.statusCode === 404) process.exit(0); }
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
}
