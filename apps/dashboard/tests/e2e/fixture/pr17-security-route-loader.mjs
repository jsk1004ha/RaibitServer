import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import ts from 'typescript';

const routeUrl = new URL('../../../app/api/control/[...path]/route.ts', import.meta.url);
const securityUrl = new URL('../../../lib/request-security.js', import.meta.url);
const require = createRequire(import.meta.url);
const requestHeaders = new AsyncLocalStorage();
export async function headers() { return requestHeaders.getStore(); }
export async function cookies() {
  return new (require('next/server').NextRequest)('https://console.raibit.test', { headers: await headers() }).cookies;
}

export async function loadSecurityRoute({ legacyMutation = false, sessionMutation = false } = {}) {
  const { NextRequest } = require('next/server');
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'next/headers') return { url: import.meta.url, shortCircuit: true };
      if (specifier === 'next/server') return next('next/server.js', context);
      if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && existsSync(new URL(`${specifier}.ts`, context.parentURL))) return next(`${specifier}.ts`, context);
      return next(specifier, context);
    },
    load(url, context, next) {
      if (decodeURI(url) === decodeURI(routeUrl.href) || url.endsWith('/lib/api.ts')) return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      };
      if (sessionMutation && /\/(session-cookies|request-security)\.js$/.test(url)) {
        return { format: 'module', shortCircuit: true, source: readFileSync(new URL(url), 'utf8')
          .replace("SESSION_COOKIE_NAME = '__Host-raibitserver_session'", "SESSION_COOKIE_NAME = 'raibitserver_session'") };
      }
      if (legacyMutation && decodeURI(url) === decodeURI(securityUrl.href)) {
        const source = readFileSync(securityUrl, 'utf8');
        for (const suffix of ['state', 'verifier']) {
          if (!source.includes(`'__Host-raibitserver_github_oauth_${suffix}'`)) throw new Error('pr17_mutation_target_missing');
        }
        return { format: 'module', shortCircuit: true, source: source
          .replaceAll('__Host-raibitserver_github_oauth_state', 'raibitserver_github_oauth_state')
          .replaceAll('__Host-raibitserver_github_oauth_verifier', 'raibitserver_github_oauth_verifier') };
      }
      return next(url, context);
    },
  });
  try {
    return { ...(await import(routeUrl.href)), NextRequest,
      withHeaders: (value, run) => requestHeaders.run(value, run), close: () => hooks.deregister() };
  } catch (error) { hooks.deregister(); throw error; }
}
