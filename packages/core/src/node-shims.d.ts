declare const process: any;
declare const Buffer: any;
declare module 'node:crypto' { const mod: any; export default mod; }
declare module 'node:net' { export const isIP: any; }
declare module 'node:url' { export const domainToASCII: any; }
declare module 'node:path' { const mod: any; export default mod; }
declare module 'node:fs/promises' { const mod: any; export default mod; }
declare module 'node:child_process' { export const spawn: any; }
declare module 'node:events' { export const once: any; }
declare module 'node:os' { const mod: any; export default mod; }
declare module 'node:sqlite' { export const DatabaseSync: any; const mod: any; export default mod; }
