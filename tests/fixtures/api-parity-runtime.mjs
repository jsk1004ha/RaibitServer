import { createRequire, registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const apiRoot = new URL('../../apps/api/', import.meta.url);
const apiRequire = createRequire(new URL('package.json', apiRoot));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(apiRoot.href)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(apiRoot.href) && url.endsWith('.ts')) {
      const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, emitDecoratorMetadata: true },
        fileName: fileURLToPath(url),
      }).outputText;
      return { format: 'commonjs', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { NestFactory, ModulesContainer } = apiRequire('@nestjs/core');
const { RequestMethod } = apiRequire('@nestjs/common');
const { PATH_METADATA, METHOD_METADATA, HTTP_CODE_METADATA } = apiRequire('@nestjs/common/constants');
const { AppModule } = apiRequire('./src/app.module.ts');
const { RAIBITSERVERService } = apiRequire('./src/raibitserver.service.ts');

export async function bootParityApi(mutation = {}) {
  process.env.NODE_ENV = 'test';
  process.env.RAIBITSERVER_AUTH_MODE = 'jwt';
  delete process.env.RAIBITSERVER_AUTH_DISABLED_CONFIRM;
  process.env.RAIBITSERVER_ALLOW_MEMORY_PERSISTENCE = '1';
  process.env.RAIBITSERVER_AUTH_JWT_SECRET = 'local-semantic-parity-test-secret-only';
  delete process.env.DATABASE_URL;
  const app = await NestFactory.create(AppModule, { logger: false, rawBody: true, abortOnError: false });
  if (mutation.mutation === 'invalid-fixture') app.use((req, res, next) => {
    if (req.path === mutation.path) {
      const send = res.json.bind(res);
      res.json = () => send({ invalidFixture: true });
    }
    next();
  });
  const routes = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[name];
        if (typeof handler !== 'function' || !Reflect.hasMetadata(METHOD_METADATA, handler)) continue;
        const path = `/${[Reflect.getMetadata(PATH_METADATA, controller), Reflect.getMetadata(PATH_METADATA, handler)].filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
        const openapiPath = path.replace(/:([^/]+)/g, '{$1}');
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)].toLowerCase();
        const operationId = `${openapiPath.replace(/\/\{[^}]+\}/g, '').replace(/^\//, '').replaceAll('/', '-')}${method === 'get' ? '' : `-${method}`}`;
        if (mutation.path === openapiPath && mutation.method === method) {
          if (mutation.mutation === 'wrong-method') Reflect.defineMetadata(METHOD_METADATA, RequestMethod.POST, handler);
          if (mutation.mutation === 'delete-route') Reflect.deleteMetadata(PATH_METADATA, handler);
        }
        routes.push({ operationId, path: openapiPath, method: RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)].toLowerCase(),
          status: Reflect.getMetadata(HTTP_CODE_METADATA, handler) ?? (method === 'post' ? 201 : 200),
          permission: Reflect.getMetadata('raibitserver:permission', handler) ?? null,
          controller: controller.name, handler: name, deleted: !Reflect.hasMetadata(PATH_METADATA, handler) });
      }
    }
  }
  await app.listen(0, '127.0.0.1');
  return { app, routes: routes.filter((route) => !route.deleted), baseUrl: await app.getUrl(), repository: await app.get(RAIBITSERVERService).repositoryPromise };
}
