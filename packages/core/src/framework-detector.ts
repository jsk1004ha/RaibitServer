function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hasAnyDependency(pkg, names) {
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.optionalDependencies || {}),
  };
  return names.find((name) => Object.prototype.hasOwnProperty.call(deps, name));
}

function fileExists(files, name) {
  return Object.prototype.hasOwnProperty.call(files || {}, name);
}

function getFile(files, name) {
  return files?.[name];
}

function packageManagerFor(files, packageJson) {
  if (fileExists(files, 'pnpm-lock.yaml')) return 'pnpm';
  if (fileExists(files, 'yarn.lock')) return 'yarn';
  if (fileExists(files, 'bun.lock') || fileExists(files, 'bun.lockb')) return 'bun';
  if (fileExists(files, 'package-lock.json') || fileExists(files, 'npm-shrinkwrap.json')) return 'npm';
  const configured = String(packageJson.packageManager || '').split('@')[0].toLowerCase();
  return ['npm', 'pnpm', 'yarn', 'bun'].includes(configured) ? configured : 'npm';
}

function installCommandFor(files, packageJson) {
  const manager = packageManagerFor(files, packageJson);
  if (manager === 'pnpm') return fileExists(files, 'pnpm-lock.yaml') ? 'pnpm install --frozen-lockfile' : 'pnpm install';
  if (manager === 'yarn') {
    const version = Number(String(packageJson.packageManager || '').match(/^yarn@(\d+)/)?.[1] || 1);
    return fileExists(files, 'yarn.lock') ? (version >= 2 ? 'yarn install --immutable' : 'yarn install --frozen-lockfile') : 'yarn install';
  }
  if (manager === 'bun') return fileExists(files, 'bun.lock') || fileExists(files, 'bun.lockb') ? 'bun install --frozen-lockfile' : 'bun install';
  return fileExists(files, 'package-lock.json') || fileExists(files, 'npm-shrinkwrap.json') ? 'npm ci' : 'npm install';
}

function scriptCommand(packageJson, script, fallback) {
  return packageJson.scripts?.[script] || fallback;
}

export function detectFramework(files = {}) {
  const packageJson = parseJson(getFile(files, 'package.json'));
  const scripts = packageJson.scripts || {};
  const installCommand = installCommandFor(files, packageJson);

  if (fileExists(files, 'package.json')) {
    if (hasAnyDependency(packageJson, ['next'])) {
      return {
        framework: 'nextjs',
        runtime: 'node',
        serviceType: 'web',
        installCommand,
        buildCommand: scripts.build || 'npm run build',
        startCommand: scripts.start || 'npm start',
        port: 3000,
        outputDirectory: '.next',
      };
    }
    if (hasAnyDependency(packageJson, ['nuxt'])) {
      return {
        framework: 'nuxt', runtime: 'node', serviceType: 'web', installCommand,
        buildCommand: scriptCommand(packageJson, 'build', 'npm run build'),
        startCommand: scriptCommand(packageJson, 'start', 'node .output/server/index.mjs'),
        port: 3000, outputDirectory: '.output',
      };
    }
    if (hasAnyDependency(packageJson, ['@sveltejs/kit'])) {
      return {
        framework: 'sveltekit', runtime: 'node', serviceType: 'web', installCommand,
        buildCommand: scriptCommand(packageJson, 'build', 'npm run build'),
        startCommand: scriptCommand(packageJson, 'start', 'node build'),
        port: 3000, outputDirectory: 'build',
      };
    }
    if (hasAnyDependency(packageJson, ['astro'])) {
      const server = hasAnyDependency(packageJson, ['@astrojs/node']);
      return {
        framework: 'astro', runtime: server ? 'node' : 'static', serviceType: 'web', installCommand,
        buildCommand: scriptCommand(packageJson, 'build', 'npm run build'),
        startCommand: server ? scriptCommand(packageJson, 'start', 'node dist/server/entry.mjs') : null,
        port: server ? 4321 : 80, outputDirectory: 'dist', ...(server ? {} : { staticContainer: 'caddy' }),
      };
    }
    if (hasAnyDependency(packageJson, ['@nestjs/core'])) {
      return {
        framework: 'nestjs',
        runtime: 'node',
        serviceType: 'web',
        installCommand,
        buildCommand: scripts.build || 'npm run build',
        startCommand: scripts.start || 'npm run start:prod',
        port: 3000,
        outputDirectory: 'dist',
      };
    }
    if (hasAnyDependency(packageJson, ['express', 'fastify', 'koa', 'hono'])) {
      return {
        framework: 'node-http',
        runtime: 'node',
        serviceType: 'web',
        installCommand,
        buildCommand: scripts.build || null,
        startCommand: scripts.start || 'npm start',
        port: 3000,
        outputDirectory: null,
      };
    }
    if (hasAnyDependency(packageJson, ['vite', '@vitejs/plugin-react', 'vue', 'svelte'])) {
      return {
        framework: 'static-spa',
        runtime: 'static',
        serviceType: 'web',
        installCommand,
        buildCommand: scripts.build || 'npm run build',
        startCommand: null,
        port: 80,
        outputDirectory: 'dist',
        staticContainer: 'caddy',
      };
    }
    return {
      framework: 'node-generic',
      runtime: 'node',
      serviceType: 'web',
      installCommand,
      buildCommand: scripts.build || null,
      startCommand: scripts.start || 'npm start',
      port: 3000,
      outputDirectory: scripts.build ? 'dist' : null,
    };
  }

  if (fileExists(files, 'requirements.txt') || fileExists(files, 'pyproject.toml')) {
    const requirements = String(getFile(files, 'requirements.txt') || '').toLowerCase();
    const pythonManifest = `${requirements}\n${String(getFile(files, 'pyproject.toml') || '').toLowerCase()}`;
    const isFastApi = pythonManifest.includes('fastapi');
    const isDjango = pythonManifest.includes('django');
    const isFlask = pythonManifest.includes('flask');
    const framework = isFastApi ? 'fastapi' : isDjango ? 'django' : isFlask ? 'flask' : 'python';
    const startCommand = isFastApi
      ? 'uvicorn main:app --host 0.0.0.0 --port $PORT'
      : isDjango
        ? 'python manage.py runserver 0.0.0.0:$PORT'
        : isFlask
          ? 'flask run --host 0.0.0.0 --port $PORT'
          : 'python app.py';
    return {
      framework,
      runtime: 'python',
      serviceType: 'web',
      installCommand: fileExists(files, 'requirements.txt') ? 'pip install -r requirements.txt' : 'pip install .',
      buildCommand: null,
      startCommand,
      port: 8000,
      outputDirectory: null,
    };
  }

  if (fileExists(files, 'pom.xml') || fileExists(files, 'build.gradle') || fileExists(files, 'build.gradle.kts')) {
    const javaManifest = `${String(getFile(files, 'pom.xml') || '')}\n${String(getFile(files, 'build.gradle') || '')}\n${String(getFile(files, 'build.gradle.kts') || '')}`.toLowerCase();
    const isSpring = javaManifest.includes('spring-boot') || javaManifest.includes('springframework.boot');
    const isMaven = fileExists(files, 'pom.xml');
    return {
      framework: isSpring ? 'spring-boot' : 'java',
      runtime: 'jvm',
      serviceType: 'web',
      installCommand: null,
      buildCommand: isMaven ? 'mvn package -DskipTests' : './gradlew build -x test',
      startCommand: isSpring ? `java -jar ${isMaven ? 'target/*.jar' : 'build/libs/*.jar'}` : 'java -jar app.jar',
      port: 8080,
      outputDirectory: isMaven ? 'target' : 'build/libs',
    };
  }

  if (fileExists(files, 'go.mod')) {
    return {
      framework: 'go',
      runtime: 'go',
      serviceType: 'web',
      installCommand: null,
      buildCommand: 'go build -o app ./...',
      startCommand: './app',
      port: 8080,
      outputDirectory: '.',
    };
  }

  if (fileExists(files, 'index.html')) {
    return {
      framework: 'static-html',
      runtime: 'static',
      serviceType: 'web',
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      port: 80,
      outputDirectory: '.',
      staticContainer: 'caddy',
    };
  }

  return {
    framework: 'unknown',
    runtime: 'container',
    serviceType: 'web',
    installCommand: null,
    buildCommand: null,
    startCommand: null,
    port: 8080,
    outputDirectory: null,
  };
}
